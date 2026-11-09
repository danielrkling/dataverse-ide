/*
 * Custom just-bash commands for the terminal.
 *
 * `node` delegates to the existing direct-fs node runtime, so the terminal
 * and "Node: Run File" share one execution engine. `npm` reuses the direct
 * installer for installs and the shell itself for script execution. `npx`
 * resolves package binaries from node_modules and runs them with the same
 * Node runtime, installing the package first when needed.
 */

import type * as vscodeType from "vscode";

import type { Command, CommandContext, CustomCommand, ExecResult } from "just-bash";

import type { DirectNodeEngine } from "../node-runtime/engine.js";
import { getNodeFsCacheMode, type NodeFsCacheMode } from "../node-runtime/fsCache.js";
import type { NodePermissionLevel } from "../node-runtime/permissions.js";

import type { ShellFs } from "./shellFs.js";
import type { ShellOutput } from "./output.js";
import { getTerminalCommandContributions } from "./registry.js";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
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
  node [--eager|--lazy] <file> [args...]
                          run a JavaScript/TypeScript file
  node --version          print the browser Node version
  npm run <script>        run a package.json script
  npm test | npm start    shortcuts for the "test"/"start" scripts
  npm install [pkg...]    install dependencies through the npm extension
  npx [options] <command> [args...]
                          run a package binary, installing it if needed
  open <file>             open a workspace file in the editor
  code <file>             alias for open

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

function unscopedPackageName(name: string): string {
  const slash = name.lastIndexOf("/");

  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** Extracts the package name from an npm spec such as `tsc` or `typescript@5`. */
function packageNameFromSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");

    if (slash < 0) {
      return spec;
    }

    const versionAt = spec.indexOf("@", slash + 1);

    return versionAt < 0 ? spec : spec.slice(0, versionAt);
  }

  const versionAt = spec.indexOf("@");

  return versionAt <= 0 ? spec : spec.slice(0, versionAt);
}

async function readInstalledPackageJson(
  fs: ShellFs,
  packageName: string,
): Promise<PackageJson | undefined> {
  const path = fs.resolvePath("/", `node_modules/${packageName}/package.json`);

  try {
    return JSON.parse(await fs.readFile(path)) as PackageJson;
  } catch {
    return undefined;
  }
}

/**
 * Finds a binary with this exact name among installed top-level packages.
 *
 * The npm installer does not create `node_modules/.bin`, so `npx tsc` cannot
 * rely on a shim. Scanning manifests lets it find the TypeScript package's
 * `tsc` bin without asking the user for `-p typescript`.
 */
async function findInstalledBinByName(
  fs: ShellFs,
  command: string,
): Promise<PackageBin | undefined> {
  let names: string[];

  try {
    names = await fs.readdir("/node_modules");
  } catch {
    return undefined;
  }

  const candidates: string[] = [];

  for (const name of names) {
    if (name === ".bin" || name.startsWith(".")) {
      continue;
    }

    if (!name.startsWith("@")) {
      candidates.push(name);
      continue;
    }

    try {
      for (const scoped of await fs.readdir(`/node_modules/${name}`)) {
        candidates.push(`${name}/${scoped}`);
      }
    } catch {
      /* Unreadable scope directory: ignore it. */
    }
  }

  for (const packageName of candidates) {
    const manifest = await readInstalledPackageJson(fs, packageName);

    if (manifest == null) {
      continue;
    }

    const path = packageBins(manifest, packageName)[command];

    if (path != null) {
      return { packageName, name: command, path };
    }
  }

  return undefined;
}

function packageBins(manifest: PackageJson, packageName: string): Record<string, string> {
  if (typeof manifest.bin === "string") {
    return { [unscopedPackageName(manifest.name ?? packageName)]: manifest.bin };
  }

  if (manifest.bin != null && typeof manifest.bin === "object") {
    const entries: Record<string, string> = {};

    for (const [name, value] of Object.entries(manifest.bin)) {
      if (typeof value === "string") {
        entries[name] = value;
      }
    }

    return entries;
  }

  return {};
}

type PackageBin = {
  packageName: string;
  name: string;
  path: string;
};

function findPackageBin(
  manifest: PackageJson,
  packageName: string,
  command: string,
): PackageBin | undefined {
  const bins = packageBins(manifest, packageName);
  const exact = bins[command];

  if (exact != null) {
    return { packageName, name: command, path: exact };
  }

  const names = Object.keys(bins);
  const unscoped = unscopedPackageName(packageName);

  /*
   * With `-p typescript tsc` the command matches a bin name. Without an
   * explicit package, `npx esbuild` installs `esbuild` and its single bin is
   * the command even when the manifest spells the name differently.
   */
  if (names.length === 1) {
    return { packageName, name: names[0], path: bins[names[0]] };
  }

  if (bins[unscoped] != null) {
    return { packageName, name: unscoped, path: bins[unscoped] };
  }

  return undefined;
}

type NpxInvocation = {
  packages: string[];
  command?: string;
  args: string[];
  noInstall: boolean;
  help: boolean;
  version: boolean;
  unsupported?: string;
};

function parseNpxArgs(args: string[]): NpxInvocation {
  const packages: string[] = [];
  const commandArgs: string[] = [];
  let command: string | undefined;
  let noInstall = false;
  let help = false;
  let version = false;
  let passthrough = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (passthrough) {
      if (command == null) {
        command = argument;
      } else {
        commandArgs.push(argument);
      }

      continue;
    }

    if (argument === "--") {
      passthrough = true;
      continue;
    }

    if (command != null) {
      commandArgs.push(argument);
      continue;
    }

    if (
      argument === "-y" ||
      argument === "--yes" ||
      argument === "-q" ||
      argument === "--quiet" ||
      argument === "--silent"
    ) {
      continue;
    }

    if (argument === "--no-install" || argument === "--no") {
      noInstall = true;
      continue;
    }

    if (argument === "-p" || argument === "--package") {
      const value = args[index + 1];

      if (value == null) {
        return {
          packages,
          command,
          args: commandArgs,
          noInstall,
          help,
          version,
          unsupported: argument,
        };
      }

      packages.push(value);
      index++;
      continue;
    }

    if (argument.startsWith("--package=")) {
      const value = argument.slice("--package=".length);

      if (value.length > 0) {
        packages.push(value);
      }

      continue;
    }

    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }

    if (argument === "-v" || argument === "--version") {
      version = true;
      continue;
    }

    if (argument.startsWith("-")) {
      return {
        packages,
        command,
        args: commandArgs,
        noInstall,
        help,
        version,
        unsupported: argument,
      };
    }

    command = argument;
  }

  return { packages, command, args: commandArgs, noInstall, help, version };
}

const NPX_HELP = `Usage: npx [options] <command> [args...]

Runs a package binary from node_modules, installing the package first when
needed. Pass --no-install to require an existing installation.

Options:
  -p, --package <spec>  package to install/use (repeatable)
  -y, --yes             accepted for compatibility; installs are non-interactive
  --no-install          only use an already-installed package
  -h, --help            show this help
  -v, --version         print the npx version
`;

function createOpenCommands(options: ShellCommandOptions, defineCommand: DefineCommand): Command[] {
  const open = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (args.length === 0) {
      return error("usage: open <file> [file...]");
    }

    for (const argument of args) {
      const absolute = ctx.fs.resolvePath(ctx.cwd, argument);

      try {
        const stat = await ctx.fs.stat(absolute);

        if (stat.isDirectory) {
          return error(`open: is a directory: ${argument}`);
        }

        const relative = absolute.replace(/^\/+/, "");
        const uri = options.vscode.Uri.joinPath(options.rootUri, ...relative.split("/"));

        await options.vscode.commands.executeCommand("vscode.open", uri);
      } catch (openError) {
        return error(
          `open: ${argument}: ${
            openError instanceof Error ? openError.message : String(openError)
          }`,
        );
      }
    }

    return ok();
  };

  return [defineCommand("open", open), defineCommand("code", open)];
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

async function runNodeEntry(
  options: ShellCommandOptions,
  ctx: CommandContext,
  entry: string,
  argv: string[],
  fsCacheOverride: NodeFsCacheMode | undefined,
  label: string,
): Promise<ExecResult> {
  const streaming = options.output.isStreaming();
  let stdout = "";
  let stderr = "";

  try {
    const engine = await options.engine();
    const exitCode = await engine.runProgram(entry, {
      cwd: ctx.cwd,
      argv,
      level: options.level,
      fsCache: fsCacheOverride ?? getNodeFsCacheMode(options.vscode, options.rootUri),
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
    return error(`${label}: ${runError instanceof Error ? runError.message : String(runError)}`);
  }
}

function createNpxCommand(options: ShellCommandOptions, defineCommand: DefineCommand) {
  return defineCommand("npx", async (args, ctx): Promise<ExecResult> => {
    const invocation = parseNpxArgs(args);

    if (invocation.help) {
      return ok(NPX_HELP);
    }

    if (invocation.version) {
      return ok("10.0.0\n");
    }

    if (invocation.unsupported != null) {
      return error(`npx: unsupported option "${invocation.unsupported}".`);
    }

    if (invocation.command == null) {
      return error("usage: npx [options] <command> [args...]");
    }

    const packages = invocation.packages.length > 0 ? invocation.packages : [invocation.command];
    const streaming = options.output.isStreaming();
    let progress = "";

    const report = (message: string): void => {
      if (streaming) {
        options.output.write(`${message}\n`);
      } else {
        progress += `${message}\n`;
      }
    };

    let bin: PackageBin | undefined;

    if (invocation.packages.length === 0) {
      bin = await findInstalledBinByName(options.fs, invocation.command);
    }

    if (bin == null) {
      const candidates: Array<{ packageName: string; manifest: PackageJson }> = [];

      for (const spec of packages) {
        const packageName = packageNameFromSpec(spec);
        let manifest = await readInstalledPackageJson(options.fs, packageName);

        if (manifest == null) {
          if (invocation.noInstall) {
            return error(`npx: package "${packageName}" is not installed (--no-install).`);
          }

          report(`npx: installing ${spec}...`);

          try {
            const { directInstall } = await import("../npm/directInstaller.js");

            await directInstall(
              options.vscode,
              options.rootUri,
              {
                specs: [spec],
                save: false,
                onProgress: report,
              },
              "dependencies",
            );

            await options.fs.refreshIndex();
          } catch (installError) {
            return error(
              `npx: ${installError instanceof Error ? installError.message : String(installError)}`,
            );
          }

          manifest = await readInstalledPackageJson(options.fs, packageName);
        }

        if (manifest == null) {
          return error(
            `npx: package "${packageName}" was installed but its package.json is missing.`,
          );
        }

        candidates.push({ packageName, manifest });
      }

      for (const candidate of candidates) {
        bin = findPackageBin(candidate.manifest, candidate.packageName, invocation.command);

        if (bin != null) {
          break;
        }
      }

      if (bin == null) {
        const label = candidates.map((candidate) => candidate.packageName).join(", ");

        return error(`npx: could not find a binary named "${invocation.command}" in ${label}.`);
      }
    }

    const packageRoot = options.fs.resolvePath("/", `node_modules/${bin.packageName}`);
    const binPath = options.fs.resolvePath(packageRoot, bin.path);

    if (binPath !== packageRoot && !binPath.startsWith(`${packageRoot}/`)) {
      return error(`npx: binary "${bin.name}" points outside its package.`);
    }

    try {
      const stat = await options.fs.stat(binPath);

      if (stat.isDirectory) {
        return error(`npx: binary "${bin.name}" is a directory.`);
      }
    } catch {
      return error(`npx: binary "${bin.name}" is missing at ${binPath}.`);
    }

    const result = await runNodeEntry(options, ctx, binPath, invocation.args, undefined, "npx");

    return {
      stdout: progress + result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
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

    let fsCacheOverride: NodeFsCacheMode | undefined;
    let index = 0;

    /*
     * Node-style option placement: runtime flags come before the entry file
     * and script arguments (`node --eager script.ts --flag`) stay untouched.
     */
    while (index < args.length) {
      const argument = args[index];

      if (argument === "--eager") {
        fsCacheOverride = "eager";
        index += 1;
        continue;
      }

      if (argument === "--lazy") {
        fsCacheOverride = "lazy";
        index += 1;
        continue;
      }

      break;
    }

    const entry = args[index];

    if (entry == null) {
      return error("node: missing entry file. Use `node [--eager|--lazy] <file> [args...]`.");
    }

    if (entry.startsWith("-")) {
      return error(
        `node: unsupported option "${entry}". Use \`node [--eager|--lazy] <file> [args...]\`.`,
      );
    }

    const argv = args.slice(index + 1);

    return runNodeEntry(options, ctx, entry, argv, fsCacheOverride, "node");
  });
}

export async function createShellCommands(options: ShellCommandOptions): Promise<CustomCommand[]> {
  /*
   * Imported on first terminal creation rather than extension activation.
   * The browser bundle is ~1 MB; boot should not pay for it until the user
   * actually opens a shell.
   */
  const { defineCommand } = await import("just-bash");
  const builtins = [
    ...createOpenCommands(options, defineCommand),
    createNodeCommand(options, defineCommand),
    createNpmCommand(options, defineCommand),
    createNpxCommand(options, defineCommand),
  ];
  const builtinNames = new Set(builtins.map((command) => command.name));
  const terminalContext = {
    vscode: options.vscode,
    rootUri: options.rootUri,
    fs: options.fs,
    output: options.output,
  };
  const contributed = getTerminalCommandContributions()
    .filter((contribution) => !builtinNames.has(contribution.name))
    .map((contribution) =>
      defineCommand(contribution.name, (args, ctx) =>
        contribution.execute(args, ctx, terminalContext),
      ),
    );

  return [...builtins, ...contributed];
}

export function shellHelp(): string {
  return SHELL_HELP;
}
