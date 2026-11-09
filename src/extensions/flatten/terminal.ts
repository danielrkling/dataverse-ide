/*
 * `flatten` command for the Dataverse shell.
 *
 * Selected paths are converted to workspace URIs and handed to the same
 * command the explorer context menu uses. With no paths (or `--configured`)
 * the configured include list from settings is used.
 */

import type * as vscodeType from "vscode";

import type { CommandContext, ExecResult } from "just-bash";

import { registerTerminalCommand, type TerminalCommandDisposable } from "../terminal/registry.js";
import { workspaceUriForShellPath } from "../terminal/workspaceUri.js";

const HELP = `usage: flatten [path...]

Combine files into a markdown bundle written to the workspace root.

  flatten                 use dataverseIde.flatten.include
  flatten <path...>       combine the given files or folders
  flatten --configured    use dataverseIde.flatten.include
  flatten --help          show this help
`;

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function error(message: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr: `flatten: ${message}\n`, exitCode };
}

function result(fileName: string | undefined): ExecResult {
  return fileName == null
    ? error("no bundle was written (see the flatten output channel).")
    : ok(`flatten: wrote ${fileName}.\n`);
}

export function registerFlattenTerminalCommands(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): TerminalCommandDisposable {
  return registerTerminalCommand({
    name: "flatten",
    description: "Combine workspace files into a markdown bundle.",

    async execute(args, ctx: CommandContext): Promise<ExecResult> {
      try {
        if (args.some((arg) => arg === "help" || arg === "--help" || arg === "-h")) {
          return ok(HELP);
        }

        const configured = args.some((arg) => arg === "--configured" || arg === "-c");
        const unknownFlag = args.find(
          (arg) => arg.startsWith("-") && arg !== "--configured" && arg !== "-c" && arg !== "--",
        );

        if (unknownFlag != null) {
          return error(`unknown option "${unknownFlag}". Try \`flatten --help\`.`);
        }

        const paths = args.filter((arg) => !arg.startsWith("-"));

        if (configured || paths.length === 0) {
          const fileName = await vscode.commands.executeCommand<string>(
            "dataverseIde.flatten.configured",
          );

          return result(fileName);
        }

        const uris = paths.map((path) => workspaceUriForShellPath(vscode, rootUri, ctx, path));
        const fileName = await vscode.commands.executeCommand<string>(
          "dataverseIde.flatten.selected",
          uris,
        );

        return result(fileName);
      } catch (flattenError) {
        return error(flattenError instanceof Error ? flattenError.message : String(flattenError));
      }
    },
  });
}
