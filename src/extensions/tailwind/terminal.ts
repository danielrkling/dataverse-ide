/*
 * `tailwind` command for the Dataverse shell.
 *
 * The compile/watch state lives in the tailwind extension, so the shell
 * command delegates to the same command handlers the palette uses. The
 * compile handler returns a boolean so the terminal gets a real exit code.
 */

import type * as vscodeType from "vscode";

import type { ExecResult } from "just-bash";

import { registerTerminalCommand, type TerminalCommandDisposable } from "../terminal/registry.js";

import { readTailwindConfig } from "./config.js";

const HELP = `usage: tailwind [command]

Commands:
  tailwind                 compile the configured Tailwind CSS
  tailwind build           same as above
  tailwind watch           start watch mode
  tailwind stop            stop watch mode
  tailwind toggle          toggle watch mode
  tailwind config          open tailwind.config.json
  tailwind output          show the tailwind output channel
  tailwind guide           open the Tailwind guide
`;

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function error(message: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr: `tailwind: ${message}\n`, exitCode };
}

export function registerTailwindTerminalCommands(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): TerminalCommandDisposable {
  return registerTerminalCommand({
    name: "tailwind",
    description: "Compile Tailwind CSS, or control tailwind watch mode.",

    async execute(args): Promise<ExecResult> {
      const [subcommand] = args;

      try {
        if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
          return ok(HELP);
        }

        if (subcommand === "watch" || subcommand === "start") {
          await vscode.commands.executeCommand("dataverseIde.tailwind.startWatch");

          return ok("tailwind: watching.\n");
        }

        if (subcommand === "stop") {
          await vscode.commands.executeCommand("dataverseIde.tailwind.stopWatch");

          return ok("tailwind: watch stopped.\n");
        }

        if (subcommand === "toggle") {
          await vscode.commands.executeCommand("dataverseIde.tailwind.toggleWatch");

          return ok("tailwind: watch toggled.\n");
        }

        if (subcommand === "config") {
          await vscode.commands.executeCommand("dataverseIde.tailwind.openConfig");

          return ok();
        }

        if (subcommand === "output") {
          await vscode.commands.executeCommand("dataverseIde.tailwind.showOutput");

          return ok();
        }

        if (subcommand === "guide") {
          await vscode.commands.executeCommand("dataverseIde.tailwind.openGuide");

          return ok();
        }

        if (subcommand != null && subcommand !== "build" && subcommand !== "compile") {
          return error(`unknown command "${subcommand}". Try \`tailwind --help\`.`);
        }

        const compiled = await vscode.commands.executeCommand<boolean>(
          "dataverseIde.tailwind.compileCss",
        );

        if (compiled === false) {
          return error("compile failed (see the tailwind output channel).");
        }

        const { config } = await readTailwindConfig(vscode, rootUri);

        return ok(`tailwind: compiled ${config.output}.\n`);
      } catch (compileError) {
        return error(compileError instanceof Error ? compileError.message : String(compileError));
      }
    },
  });
}
