/*
 * `dataverse` command for the Dataverse shell.
 *
 * Uploads, previews and schema operations delegate to the same command
 * handlers as the palette. Upload handlers return a small summary so the
 * shell can report counts and a failed exit code.
 */

import type * as vscodeType from "vscode";

import type { CommandContext, ExecResult } from "just-bash";

import { registerTerminalCommand, type TerminalCommandDisposable } from "../terminal/registry.js";
import { workspaceUriForShellPath } from "../terminal/workspaceUri.js";

type UploadSummary = {
  files: number;
  uploaded: number;
  failures: string[];
};

const HELP = `usage: dataverse <command> [options]

Commands:
  dataverse upload [path...]   upload configured files, or the given paths
  dataverse upload-active      upload the active editor file
  dataverse preview [path...]  preview an HTML web resource
  dataverse watch              start watch upload
  dataverse stop               stop watch upload
  dataverse identity           refresh the signed-in user identity
  dataverse config             open dataverse.config.json
  dataverse schema             open dataverse.schema.json
  dataverse schema preview     show the schema plan
  dataverse schema provision   create missing tables and columns
  dataverse schema publish     publish schema tables
  dataverse guide              open the Dataverse guide
`;

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function error(message: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr: `dataverse: ${message}\n`, exitCode };
}

function uploadResult(summary: UploadSummary | undefined): ExecResult {
  if (summary == null) {
    return ok();
  }

  const line = `${summary.uploaded} of ${summary.files} web resource(s) uploaded.\n`;

  if (summary.failures.length > 0) {
    return {
      stdout: line,
      stderr:
        `dataverse: ${summary.failures.length} upload(s) failed ` +
        "(see the Dataverse output channel).\n",
      exitCode: 1,
    };
  }

  return ok(line);
}

export function registerDataverseTerminalCommands(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): TerminalCommandDisposable {
  return registerTerminalCommand({
    name: "dataverse",
    description: "Upload web resources and manage Dataverse schema files.",

    async execute(args, ctx: CommandContext): Promise<ExecResult> {
      const [subcommand, ...rest] = args;

      try {
        if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
          return ok(HELP);
        }

        if (
          subcommand == null ||
          subcommand === "upload" ||
          subcommand === "upload-all" ||
          subcommand === "upload-configured"
        ) {
          if (subcommand === "upload" && rest.length > 0) {
            const uris = rest.map((path) => workspaceUriForShellPath(vscode, rootUri, ctx, path));

            return uploadResult(
              await vscode.commands.executeCommand<UploadSummary | undefined>(
                "dataverseIde.dataverse.uploadSelection",
                uris,
              ),
            );
          }

          return uploadResult(
            await vscode.commands.executeCommand<UploadSummary | undefined>(
              "dataverseIde.dataverse.uploadConfiguredFiles",
            ),
          );
        }

        if (subcommand === "upload-active" || subcommand === "uploadActive") {
          return uploadResult(
            await vscode.commands.executeCommand<UploadSummary | undefined>(
              "dataverseIde.dataverse.uploadActiveFile",
            ),
          );
        }

        if (subcommand === "preview") {
          const uris = rest.map((path) => workspaceUriForShellPath(vscode, rootUri, ctx, path));

          await vscode.commands.executeCommand("dataverseIde.dataverse.previewSelection", uris);

          return ok("dataverse: preview opened.\n");
        }

        if (subcommand === "watch" || subcommand === "start") {
          await vscode.commands.executeCommand("dataverseIde.dataverse.startWatch");

          return ok("dataverse: watch upload started.\n");
        }

        if (subcommand === "stop") {
          await vscode.commands.executeCommand("dataverseIde.dataverse.stopWatch");

          return ok("dataverse: watch upload stopped.\n");
        }

        if (subcommand === "identity" || subcommand === "load-identity") {
          await vscode.commands.executeCommand("dataverseIde.dataverse.loadUserIdentity");

          return ok("dataverse: identity refreshed.\n");
        }

        if (subcommand === "config") {
          await vscode.commands.executeCommand("dataverseIde.dataverse.openConfig");

          return ok();
        }

        if (subcommand === "schema") {
          const [schemaAction] = rest;

          if (schemaAction == null || schemaAction === "open") {
            await vscode.commands.executeCommand("dataverseIde.dataverse.openSchema");

            return ok();
          }

          if (schemaAction === "preview") {
            await vscode.commands.executeCommand("dataverseIde.dataverse.previewSchema");

            return ok("dataverse: schema plan opened.\n");
          }

          if (schemaAction === "provision") {
            await vscode.commands.executeCommand("dataverseIde.dataverse.provisionSchema");

            return ok("dataverse: schema provisioning finished.\n");
          }

          if (schemaAction === "publish") {
            await vscode.commands.executeCommand("dataverseIde.dataverse.publishSchema");

            return ok("dataverse: schema publish finished.\n");
          }

          return error(`unknown schema action "${schemaAction}". Try \`dataverse --help\`.`);
        }

        if (subcommand === "guide") {
          await vscode.commands.executeCommand("dataverseIde.dataverse.openGuide");

          return ok();
        }

        return error(`unknown command "${subcommand}". Try \`dataverse --help\`.`);
      } catch (dataverseError) {
        return error(
          dataverseError instanceof Error ? dataverseError.message : String(dataverseError),
        );
      }
    },
  });
}
