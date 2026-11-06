/*
 * Custom just-bash commands for the terminal.
 *
 * `node` delegates to the existing direct-fs node runtime, so the terminal
 * and "Node: Run File" share one execution engine. `npm` reuses the direct
 * installer for installs and the shell itself for script execution.
 */

import type * as vscodeType from "vscode";

import type { Command, CommandContext, CustomCommand, ExecResult } from "just-bash";

import type { DirectNodeEngine } from "../node-runtime/engine.js";
import type { NodePermissionLevel } from "../node-runtime/permissions.js";

import type { ShellFs } from "./shellFs.js";
import type { ShellOutput } from "./output.js";

type PackageJson = {
  scripts?: Record<string, string>;
};

type ShellCommandOptions = {
  vscode: typeof vscodeType;
  rootUri: vscodeType.Uri;
  fs: ShellFs;
  level: NodePermissionLevel;
  output: ShellOutput;
  engine: () => Promise<DirectNodeEngine>;
};

type DefineCommand = (
  name: string,
  execute: (args: string[], ctx: CommandContext) => Promise<ExecResult>,
) => Command;

const SHELL_HELP = `Dataverse shell commands:
  node <file> [args...]   run a JavaScript/TypeScript file
  node --version          print the browser Node version
  npm run <script>        run a package.json script
  npm test | npm start    shortcuts for the "test"/"start" scripts
  npm install [pkg...]    install dependencies through the npm extension

Everything else is provided by just-bash: ls, cat, grep, sed, awk, find,
cp, mv, rm, mkdir, echo, printf, jq, yq, tar, ... .
`;

function ok(stdout = "", stderr = "", exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode };
}

function error(message: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr: `${message}\n`, exitCode };
}

async function readPackageJson(fs: ShellFs, cwd: string): Promise<PackageJson | undefined> {
  const path = fs.resolvePath(cwd, "package.json");

  try {
    return JSON.parse(await fs.readFile(path)) as PackageJson;
  } catch {
    return undefined;
  }
}

function quoteArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseInstallArgs(args: string[]): {
  specs: string[];
  section: "dependencies" | "devDependencies";
  save: boolean;
} {
  const specs: string[] = [];
  let section: "dependencies" | "devDependencies" = "dependencies";
  let save = true;

  for (const arg of args) {
    if (arg === "--save-dev" || arg === "-D") {
      section = "devDependencies";
      continue;
    }

    if (arg === "--save" || arg === "-S") {
      section = "dependencies";
      continue;
    }

    if (arg === "--no-save") {
      save = false;
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    specs.push(arg);
  }

  return { specs, section, save };
}

async function runNpmScript(
  ctx: CommandContext,
  script: string,
  extraArgs: string[],
): Promise<ExecResult> {
  if (ctx.exec == null) {
    return error("npm: the shell cannot execute scripts in this context.");
  }

  const command = [script, ...extraArgs.map(quoteArgument)].join(" ");

  return ctx.exec(command, {
    cwd: ctx.cwd,
    env: ctx.exportedEnv,
    stdin: ctx.stdin,
  });
}

function createNpmCommand(options: ShellCommandOptions, defineCommand: DefineCommand) {
  return defineCommand("npm", async (args, ctx): Promise<ExecResult> => {
    const [subcommand, ...rest] = args;

    if (subcommand == null || subcommand === "--version" || subcommand === "-v") {
      return ok("10.0.0\n");
    }

    if (subcommand === "run" || subcommand === "run-script") {
      const packageJson = await readPackageJson(options.fs, ctx.cwd);

      if (packageJson?.scripts == null) {
        return error("npm: no package.json with scripts was found.");
      }

      const scriptName = rest[0];

      if (scriptName == null) {
        return ok(
          Object.keys(packageJson.scripts)
            .map((name) => `  ${name}: ${packageJson.scripts?.[name] ?? ""}`)
            .join("\n") + "\n",
        );
      }

      const script = packageJson.scripts[scriptName];

      if (script == null) {
        return error(`npm: missing script "${scriptName}".`);
      }

      const separator = rest.indexOf("--");
      const extraArgs = separator >= 0 ? rest.slice(separator + 1) : rest.slice(1);
      let stdout = "";
      let stderr = "";

      for (const hook of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
        const hookScript = packageJson.scripts[hook];

        if (hookScript == null) {
          continue;
        }

        const result = await runNpmScript(ctx, hookScript, hook === scriptName ? extraArgs : []);

        stdout += result.stdout;
        stderr += result.stderr;

        if (result.exitCode !== 0) {
          return { stdout, stderr, exitCode: result.exitCode };
        }
      }

      return ok(stdout, stderr);
    }

    if (subcommand === "test" || subcommand === "t") {
      const packageJson = await readPackageJson(options.fs, ctx.cwd);
      const script = packageJson?.scripts?.test;

      return script == null
        ? error('npm: missing script "test".')
        : runNpmScript(ctx, script, rest);
    }

    if (subcommand === "start") {
      const packageJson = await readPackageJson(options.fs, ctx.cwd);
      const script = packageJson?.scripts?.start;

      return script == null
        ? error('npm: missing script "start".')
        : runNpmScript(ctx, script, rest);
    }

    if (subcommand === "install" || subcommand === "i" || subcommand === "add") {
      const { specs, section, save } = parseInstallArgs(rest);
      let stdout = "";

      try {
        const { directInstall } = await import("../npm/directInstaller.js");

        await directInstall(
          options.vscode,
          options.rootUri,
          {
            specs: specs.length > 0 ? specs : undefined,
            allDependencies: specs.length === 0,
            includeDev: true,
            save,
            onProgress: (message) => {
              stdout += `${message}\n`;
            },
          },
          section,
        );

        await options.fs.refreshIndex();

        return ok(`${stdout}npm: install complete.\n`);
      } catch (installError) {
        return error(
          `npm: ${installError instanceof Error ? installError.message : String(installError)}`,
        );
      }
    }

    if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      return ok("npm run <script> | npm test | npm start | npm install [pkg...]\n");
    }

    return error(`npm: unsupported command "${subcommand}".`);
  });
}

function createNodeCommand(options: ShellCommandOptions, defineCommand: DefineCommand) {
  return defineCommand("node", async (args, ctx): Promise<ExecResult> => {
    if (args.length === 0) {
      return error(
        "node: the interactive REPL is not available in the browser terminal. Use `node <file>`.",
      );
    }

    if (args[0] === "--version" || args[0] === "-v") {
      return ok("v20.0.0 (almostnode shims)\n");
    }

    if (args[0] === "--help" || args[0] === "-h") {
      return ok(SHELL_HELP);
    }

    if (args[0].startsWith("-")) {
      return error(`node: unsupported option "${args[0]}". Use \`node <file> [args...]\`.`);
    }

    const entry = args[0];
    const argv = args.slice(1);
    const streaming = options.output.isStreaming();
    let stdout = "";
    let stderr = "";

    try {
      const engine = await options.engine();
      const exitCode = await engine.runProgram(entry, {
        cwd: ctx.cwd,
        argv,
        level: options.level,
        stdout: (data) => {
          if (streaming) {
            options.output.write(data);
          } else {
            stdout += data;
          }
        },
        stderr: (data) => {
          if (streaming) {
            options.output.write(data);
          } else {
            stderr += data;
          }
        },
        log: () => {
          /* The terminal owns the prompt; runtime status stays out of it. */
        },
        prefixConsole: false,
      });

      return { stdout, stderr, exitCode };
    } catch (runError) {
      return error(`node: ${runError instanceof Error ? runError.message : String(runError)}`);
    }
  });
}

export async function createShellCommands(options: ShellCommandOptions): Promise<CustomCommand[]> {
  /*
   * Imported on first terminal creation rather than extension activation.
   * The browser bundle is ~1 MB; boot should not pay for it until the user
   * actually opens a shell.
   */
  const { defineCommand } = await import("just-bash");

  return [createNodeCommand(options, defineCommand), createNpmCommand(options, defineCommand)];
}

export function shellHelp(): string {
  return SHELL_HELP;
}
