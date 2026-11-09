/*
 * `git` command for the Dataverse shell.
 *
 * This is a programmatic bridge over the same service functions the SCM
 * extension uses, so terminal commands do not open SCM quick picks for the
 * common flows. Remote operations still use the configured credential
 * provider (which may prompt once and cache the result).
 */

import type { CommandContext, ExecResult } from "just-bash";

import { registerTerminalCommand, type TerminalCommandDisposable } from "../terminal/registry.js";

import {
  createCommit,
  fetchRemote,
  getGitRepositorySnapshot,
  getRecentCommits,
  initializeRepository,
  listLocalBranches,
  listRemotes,
  pullRemote,
  pushRemote,
  stageAll,
  stagePaths,
  switchBranch,
  unstageAll,
  unstagePaths,
  type GitCredentialsProvider,
} from "./service.js";

export type GitTerminalDependencies = {
  workspaceHandle: FileSystemDirectoryHandle;
  credentialProvider?: GitCredentialsProvider;
  refresh: () => Promise<void>;
  getCommitAuthor: () => Promise<{ name: string; email: string } | undefined>;
};

const HELP = `usage: git <command> [options]

Commands:
  status                     show branch and changed files
  add <path...> | . | -A     stage files (or everything)
  unstage <path...> | .      unstage files (or everything)
  commit -m <message>        create a commit (--amend to amend)
  log [count]                show recent commits
  branch                     list local branches
  switch <branch>            switch branches
  init                       initialize a repository
  remote                     list remotes
  fetch [remote]             fetch from a remote
  pull [remote]              fast-forward pull from a remote
  push [remote]              push to a remote
  help                       show this help
`;

function ok(stdout = "", stderr = "", exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode };
}

function error(message: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr: `git: ${message}\n`, exitCode };
}

function relativePath(ctx: CommandContext, value: string): string {
  return ctx.fs.resolvePath(ctx.cwd, value).replace(/^\/+/, "");
}

export function registerGitTerminalCommands(
  dependencies: GitTerminalDependencies,
): TerminalCommandDisposable[] {
  const { workspaceHandle, credentialProvider, refresh, getCommitAuthor } = dependencies;

  async function resolveRemote(name?: string): Promise<string> {
    if (name != null && name.length > 0) {
      return name;
    }

    const remotes = await listRemotes(workspaceHandle);

    if (remotes.length === 0) {
      throw new Error("no remotes configured");
    }

    if (remotes.length === 1) {
      return remotes[0].name;
    }

    throw new Error("multiple remotes configured; specify one");
  }

  function requireCredentials(): GitCredentialsProvider {
    if (credentialProvider == null) {
      throw new Error("remote credentials are not available for this workspace");
    }

    return credentialProvider;
  }

  async function status(): Promise<ExecResult> {
    const snapshot = await getGitRepositorySnapshot(workspaceHandle);

    if (!snapshot.isRepository) {
      return error("not a git repository", 128);
    }

    const lines = [`## ${snapshot.branch ?? "(detached)"}`];

    for (const entry of snapshot.entries) {
      if (entry.status === "untracked") {
        lines.push(`?? ${entry.path}`);
        continue;
      }

      const index =
        entry.head !== entry.stage ? (entry.stage === 0 ? "D" : entry.head === 0 ? "A" : "M") : " ";

      const worktree = entry.workdir !== entry.stage ? (entry.workdir === 0 ? "D" : "M") : " ";

      lines.push(`${index}${worktree} ${entry.path}`);
    }

    return ok(`${lines.join("\n")}\n`);
  }

  async function stage(ctx: CommandContext, paths: string[]): Promise<ExecResult> {
    if (paths.includes("-A") || paths.includes("--all")) {
      await stageAll(workspaceHandle);
      await refresh();

      return ok();
    }

    if (paths.length === 0) {
      return error("nothing specified, nothing added");
    }

    const snapshot = await getGitRepositorySnapshot(workspaceHandle);
    const targets = new Set<string>();
    const missing: string[] = [];

    for (const path of paths) {
      const relative = relativePath(ctx, path);

      if (relative.length === 0) {
        await stageAll(workspaceHandle);
        await refresh();

        return ok();
      }

      const matches = snapshot.entries.filter(
        (entry) =>
          entry.changed && (entry.path === relative || entry.path.startsWith(`${relative}/`)),
      );

      if (matches.length === 0) {
        missing.push(path);
      }

      for (const match of matches) {
        targets.add(match.path);
      }
    }

    if (targets.size > 0) {
      await stagePaths(workspaceHandle, [...targets]);
      await refresh();
    }

    return missing.length > 0
      ? {
          stdout: "",
          stderr: missing
            .map((path) => `fatal: pathspec '${path}' did not match any files\n`)
            .join(""),
          exitCode: 1,
        }
      : ok();
  }

  async function unstage(ctx: CommandContext, paths: string[]): Promise<ExecResult> {
    if (paths.length === 0) {
      await unstageAll(workspaceHandle);
      await refresh();

      return ok();
    }

    const snapshot = await getGitRepositorySnapshot(workspaceHandle);
    const targets = new Set<string>();
    const missing: string[] = [];

    for (const path of paths) {
      const relative = relativePath(ctx, path);

      if (relative.length === 0) {
        await unstageAll(workspaceHandle);
        await refresh();

        return ok();
      }

      const matches = snapshot.entries.filter(
        (entry) =>
          entry.staged && (entry.path === relative || entry.path.startsWith(`${relative}/`)),
      );

      if (matches.length === 0) {
        missing.push(path);
      }

      for (const match of matches) {
        targets.add(match.path);
      }
    }

    if (targets.size > 0) {
      await unstagePaths(workspaceHandle, [...targets]);
      await refresh();
    }

    return missing.length > 0
      ? {
          stdout: "",
          stderr: missing
            .map((path) => `fatal: pathspec '${path}' did not match any files\n`)
            .join(""),
          exitCode: 1,
        }
      : ok();
  }

  async function commit(args: string[]): Promise<ExecResult> {
    let message: string | undefined;
    let amend = false;

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];

      if (argument === "--amend") {
        amend = true;
        continue;
      }

      if (argument === "-m" || argument === "--message") {
        message = args[index + 1];
        index += 1;
        continue;
      }

      if (message == null) {
        message = argument;
      }
    }

    if (message == null || message.trim().length === 0) {
      return error('commit requires a message: git commit -m "message"');
    }

    const author = await getCommitAuthor();

    if (author == null) {
      return error("commit author is not configured");
    }

    const oid = await createCommit(workspaceHandle, {
      message,
      author,
      amend,
    });

    await refresh();

    return ok(
      `[${(await getGitRepositorySnapshot(workspaceHandle)).branch ?? "HEAD"} ${oid.slice(0, 8)}] ${message}\n`,
    );
  }

  async function log(args: string[]): Promise<ExecResult> {
    const count = Math.max(1, Math.min(200, Number(args[0] ?? 10) || 10));
    const commits = await getRecentCommits(workspaceHandle, count);

    if (commits.length === 0) {
      return ok();
    }

    return ok(
      commits
        .map(
          (entry) =>
            `${entry.oid.slice(0, 8)} ${new Date(entry.timestamp * 1000)
              .toISOString()
              .slice(0, 10)} ${entry.message.split("\n")[0]}`,
        )
        .join("\n") + "\n",
    );
  }

  async function branch(): Promise<ExecResult> {
    const branches = await listLocalBranches(workspaceHandle);

    return ok(
      branches.map((entry) => `${entry.current ? "*" : " "} ${entry.name}`).join("\n") +
        (branches.length > 0 ? "\n" : ""),
    );
  }

  async function remote(args: string[]): Promise<ExecResult> {
    const remotes = await listRemotes(workspaceHandle);

    if (args[0] === "add" || args[0] === "remove") {
      return error(`use the Git: Add Remote / Remove Remote commands`);
    }

    return ok(
      remotes.map((entry) => `${entry.name}\t${entry.url}`).join("\n") +
        (remotes.length > 0 ? "\n" : ""),
    );
  }

  const git = registerTerminalCommand({
    name: "git",
    description: "Git status, staging, commits, branches and remotes.",
    async execute(args, ctx): Promise<ExecResult> {
      const [subcommand, ...rest] = args;

      try {
        switch (subcommand) {
          case undefined:
          case "help":
          case "--help":
            return ok(HELP);

          case "status":
            return await status();

          case "add":
            return await stage(ctx, rest);

          case "unstage":
          case "reset":
            return await unstage(ctx, rest);

          case "commit":
            return await commit(rest);

          case "log":
            return await log(rest);

          case "branch":
            return await branch();

          case "switch":
          case "checkout": {
            if (rest[0] == null) {
              return error("switch requires a branch name");
            }

            await switchBranch(workspaceHandle, rest[0]);
            await refresh();

            return ok(`Switched to branch '${rest[0]}'.\n`);
          }

          case "init":
            await initializeRepository(workspaceHandle);
            await refresh();

            return ok("Initialized empty Git repository.\n");

          case "remote":
            return await remote(rest);

          case "fetch": {
            const remoteName = await resolveRemote(rest[0]);
            await fetchRemote(workspaceHandle, remoteName, {
              credentialsProvider: requireCredentials(),
            });
            await refresh();

            return ok(`Fetched from '${remoteName}'.\n`);
          }

          case "pull": {
            const remoteName = await resolveRemote(rest[0]);
            const result = await pullRemote(workspaceHandle, remoteName, {
              credentialsProvider: requireCredentials(),
              fastForwardOnly: true,
            });
            await refresh();

            return ok(
              `Pulled from '${remoteName}'.${result.fetchedRef != null ? ` ${result.fetchedRef}` : ""}\n`,
            );
          }

          case "push": {
            const remoteName = await resolveRemote(rest[0]);
            const result = await pushRemote(workspaceHandle, remoteName, {
              credentialsProvider: requireCredentials(),
            });
            await refresh();

            return ok(
              `Pushed to '${remoteName}'.${result.pushedRef != null ? ` ${result.pushedRef}` : ""}\n`,
            );
          }

          default:
            return error(`unknown command '${subcommand}'. Run 'git help'.\n`);
        }
      } catch (gitError) {
        return error(gitError instanceof Error ? gitError.message : String(gitError));
      }
    },
  });

  return [git];
}
