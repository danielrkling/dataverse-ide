/*
 * A just-bash session for the terminal.
 *
 * just-bash keeps cwd/env per exec() call and returns the final state in
 * result.env (including PWD), so the session carries that state forward to
 * the next command.
 */

import { Bash, type BashExecResult, type CustomCommand, type ExecOptions } from "just-bash";

import type { ShellFs } from "./shellFs.js";

const DEFAULT_ENV: Record<string, string> = {
  HOME: "/",
  PATH: "/node_modules/.bin:/usr/bin:/bin",
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
};

export type ShellSessionOptions = {
  fs: ShellFs;
  cwd?: string;
  env?: Record<string, string>;
  commands?: CustomCommand[];
};

export type ShellSession = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  exec: (command: string, signal?: AbortSignal) => Promise<BashExecResult>;
  dispose: () => void;
};

export function createShellSession(options: ShellSessionOptions): ShellSession {
  let cwd = options.cwd ?? "/";
  let env: Record<string, string> = {
    ...DEFAULT_ENV,
    ...options.env,
    PWD: cwd,
  };

  const bash = new Bash({
    fs: options.fs,
    cwd,
    env,
    customCommands: options.commands ?? [],
    /*
     * just-bash's defense-in-depth layer monkey-patches page globals
     * (Promise.then, Function, process, ...) while a command runs. The IDE
     * shares those globals with the workbench, so keep the shell from
     * swapping them out mid-flight. Workspace permissions are the actual
     * guardrail here, not this secondary layer.
     */
    defenseInDepth: false,
  });

  return {
    get cwd(): string {
      return cwd;
    },

    get env(): Record<string, string> {
      return env;
    },

    async exec(command: string, signal?: AbortSignal): Promise<BashExecResult> {
      const execOptions: ExecOptions = {
        cwd,
        env,
        signal,
      };
      const result = await bash.exec(command, execOptions);

      /*
       * exec() runs against a copy of the shell state, so the returned env
       * (which includes PWD/OLDPWD) is the authoritative state for the next
       * command.
       */
      const nextCwd = result.env.PWD;

      if (typeof nextCwd === "string" && nextCwd.startsWith("/")) {
        cwd = nextCwd;
      }

      env = { ...result.env, PWD: cwd };

      return result;
    },

    dispose(): void {
      /* just-bash has no teardown API; the fs owns the watcher. */
    },
  };
}
