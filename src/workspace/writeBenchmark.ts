import type * as vscodeType from "vscode";

import {
  opfsOverlayProvider,
  provider,
  rootUri,
  workspaceDirectoryHandle,
  workspaceFileSystemProvider,
} from "./fsProvider.js";

/*
 * Workspace write benchmark.
 *
 * Answers "how much does the custom provider/router cost?" by timing the same
 * buffer through each layer:
 *
 *   1. vscode.workspace.fs  → extension-host RPC + FileService + router + real provider
 *   2. router.writeFile    → router + real provider (no RPC / FileService)
 *   3. provider.writeFile  → built-in HTMLFileSystemProvider only
 *   4. raw File System Access API → no VS Code code at all
 *   5. raw OPFS            → browser storage reference point
 *
 * If (2) and (3) are close, the custom layer is not the cost. If (3) is slow
 * but (4) is fast, the built-in provider is the cost. If (4) is slow too, the
 * browser/OS/sync layer is the cost.
 */

export type WriteBenchmarkSample = {
  label: string;
  bytes: number;
  ms: number;
  mbPerSecond: number;
  error?: string;
};

export type WriteBenchmarkResult = {
  bytes: number;
  samples: WriteBenchmarkSample[];
};

const BENCH_DIR = ".ide-write-bench";

const WRITE_OPTIONS = {
  create: true,
  overwrite: true,
  unlock: false,
  atomic: false,
} as const;

async function timed(
  label: string,
  bytes: number,
  operation: () => PromiseLike<unknown>,
): Promise<WriteBenchmarkSample> {
  const started = performance.now();

  try {
    await operation();
  } catch (error) {
    return {
      label,
      bytes,
      ms: performance.now() - started,
      mbPerSecond: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const ms = performance.now() - started;

  return {
    label,
    bytes,
    ms,
    mbPerSecond: bytes / 1_000_000 / (ms / 1000),
  };
}

async function writeRawFsa(data: Uint8Array, directoryName: string): Promise<void> {
  const directory = await workspaceDirectoryHandle.getDirectoryHandle(directoryName, {
    create: true,
  });

  const handle = await directory.getFileHandle("raw-fsa.bin", {
    create: true,
  });

  const writable = await handle.createWritable();

  await writable.write(data as Uint8Array<ArrayBuffer>);
  await writable.close();
}

async function writeRawOpfs(data: Uint8Array, directoryName: string): Promise<void> {
  const opfsRoot = await navigator.storage.getDirectory();
  const directory = await opfsRoot.getDirectoryHandle(directoryName, {
    create: true,
  });

  const handle = await directory.getFileHandle("raw-opfs.bin", {
    create: true,
  });

  const writable = await handle.createWritable();

  await writable.write(data as Uint8Array<ArrayBuffer>);
  await writable.close();
}

export async function benchmarkWorkspaceWrites(
  vscode: typeof vscodeType,
  sizeBytes = 400_000,
): Promise<WriteBenchmarkResult> {
  /*
   * Non-zero data, so the browser/OS cannot use sparse-file shortcuts.
   */
  const data = new Uint8Array(sizeBytes);
  data.fill(0x5a);

  const directoryUri = vscode.Uri.joinPath(rootUri, BENCH_DIR);

  await vscode.workspace.fs.createDirectory(directoryUri);

  const fullUri = vscode.Uri.joinPath(directoryUri, "full-stack.bin");
  const routerUri = vscode.Uri.joinPath(directoryUri, "router.bin");
  const providerUri = vscode.Uri.joinPath(directoryUri, "provider.bin");

  const samples: WriteBenchmarkSample[] = [];

  samples.push(
    await timed("vscode.workspace.fs (full stack)", sizeBytes, () =>
      vscode.workspace.fs.writeFile(fullUri, data),
    ),
  );

  samples.push(
    await timed("router -> built-in provider", sizeBytes, () =>
      workspaceFileSystemProvider.writeFile(routerUri, data, WRITE_OPTIONS),
    ),
  );

  samples.push(
    await timed("built-in provider only", sizeBytes, () =>
      provider.writeFile(providerUri, data, WRITE_OPTIONS),
    ),
  );

  samples.push(
    await timed("raw File System Access", sizeBytes, () => writeRawFsa(data, BENCH_DIR)),
  );

  samples.push(await timed("raw OPFS", sizeBytes, () => writeRawOpfs(data, BENCH_DIR)));

  /*
   * Also verify the OPFS overlay path (the provider used for node_modules).
   * The temp directory lives under node_modules so overlayKeyFor() routes it
   * to OPFS instead of the real folder.
   */
  const overlayDirectoryUri = vscode.Uri.joinPath(rootUri, "node_modules", BENCH_DIR);

  samples.push(
    await timed("OPFS overlay provider", sizeBytes, () =>
      opfsOverlayProvider.writeFile(
        vscode.Uri.joinPath(overlayDirectoryUri, "overlay.bin"),
        data,
        WRITE_OPTIONS,
      ),
    ),
  );

  /*
   * Cleanup. Best effort: a failed delete must not hide the measurements.
   */
  try {
    await vscode.workspace.fs.delete(directoryUri, {
      recursive: true,
      useTrash: false,
    });
  } catch {
    // Ignore cleanup errors.
  }

  try {
    await opfsOverlayProvider.delete(overlayDirectoryUri, {
      recursive: true,
      useTrash: false,
      atomic: false,
    });
  } catch {
    // Ignore cleanup errors.
  }

  try {
    const opfsRoot = await navigator.storage.getDirectory();
    await opfsRoot.removeEntry(BENCH_DIR, { recursive: true });
  } catch {
    // Ignore cleanup errors.
  }

  return { bytes: sizeBytes, samples };
}

export function formatWriteBenchmark(result: WriteBenchmarkResult): string {
  return [
    `write benchmark (${result.bytes} bytes each):`,
    ...result.samples.map(
      (sample) =>
        `  ${sample.label}: ${Math.round(sample.ms)}ms ` +
        `(${sample.mbPerSecond.toFixed(2)} MB/s)` +
        (sample.error != null ? ` — ERROR: ${sample.error}` : ""),
    ),
  ].join("\n");
}
