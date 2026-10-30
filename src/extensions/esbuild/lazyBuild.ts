import type * as vscodeType from "vscode";

import type { BuildRequestInput, BuildRunnerResponse } from "./buildRunner.js";
import type { EsbuildBuildRunner } from "./buildRunner.js";

/*
 * Lazy file resolution around the esbuild worker.
 *
 * The worker's build() may answer a build request with a PROBE response
 * (ok: true, outputs: [], needFiles: [...]): concrete paths the resolver
 * needed but the caller's file map does not contain. The caller reads those
 * from the workspace and retries, marking genuinely-unreadable paths in
 * absentPaths so later rounds finalize (warnings + externals) instead of
 * re-probing forever.
 *
 * Shared by the esbuild extension (workspace build), the tailwind compiler
 * (@plugin bundling), and the rolldown bundler (identical probe response
 * shape). Any runner exposing a structurally-compatible build() works.
 */

const MAX_LAZY_ROUNDS = 12;

export type LazyBuildLogger = {
  appendLine: (line: string) => void;
};

/** Structural runner: anything whose build() matches (rolldown runner). */
export type LazyBuildRunner = Pick<EsbuildBuildRunner, "build">;

export type LazyBuildOptions = {
  /** Output-channel log prefix, defaults to 'esbuild'. */
  logPrefix?: string;
};

export async function lazyBuild(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  runner: LazyBuildRunner,
  request: BuildRequestInput & { files: Record<string, string> },
  outputChannel?: LazyBuildLogger,
  options?: LazyBuildOptions,
): Promise<BuildRunnerResponse> {
  const logPrefix = options?.logPrefix ?? "esbuild";
  const files = request.files;
  const absentPaths = new Set<string>();

  let round = 0;
  let response = await runner.build({
    ...request,
    absentPaths: [...absentPaths],
  });

  for (;;) {
    if (!response.ok) {
      break;
    }

    const requested = response.needFiles ?? [];

    if (requested.length === 0 || round >= MAX_LAZY_ROUNDS) {
      break;
    }

    round++;

    let added = 0;
    const readFailed: string[] = [];

    for (const relativePath of requested) {
      try {
        const fileUri = vscode.Uri.joinPath(rootUri, ...relativePath.split("/"));

        const bytes = await vscode.workspace.fs.readFile(fileUri);

        files[relativePath] = new TextDecoder().decode(bytes);
        added++;
      } catch {
        /*
         * The path does not exist in the workspace. Remember that so the
         * next round finalizes (warning + external) rather than
         * re-requesting the same paths forever.
         */
        absentPaths.add(relativePath);
        readFailed.push(relativePath);
      }
    }

    outputChannel?.appendLine(
      `[${logPrefix}] lazy resolution round ${round}: read ${added} of ${requested.length} requested file(s).` +
        (readFailed.slice(0, 8).length > 0
          ? ` unreadable: ${readFailed.slice(0, 8).join(", ")}…`
          : ""),
    );

    response = await runner.build({
      ...request,
      files,
      absentPaths: [...absentPaths],
    });
  }

  return response;
}
