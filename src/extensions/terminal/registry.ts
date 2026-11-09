/*
 * Extension-contributed shell commands.
 *
 * In-house extensions register commands here during activation. The terminal
 * reads the registry when a shell is created, so commands registered before
 * the user opens a terminal are available immediately. A terminal that is
 * already open sees only the commands it was created with.
 *
 * Commands are ordinary just-bash commands: return { stdout, stderr,
 * exitCode }, and use the provided terminal context for vscode/fs/output
 * access.
 */

import type * as vscodeType from "vscode";

import type { CommandContext, ExecResult } from "just-bash";

import type { ShellFs } from "./shellFs.js";
import type { ShellOutput } from "./output.js";

export type TerminalCommandContext = {
  vscode: typeof vscodeType;
  rootUri: vscodeType.Uri;
  fs: ShellFs;
  output: ShellOutput;
};

export type TerminalCommandHandler = (
  args: string[],
  ctx: CommandContext,
  terminal: TerminalCommandContext,
) => Promise<ExecResult>;

export type TerminalCommandContribution = {
  name: string;
  description?: string;
  execute: TerminalCommandHandler;
};

export type TerminalCommandDisposable = {
  dispose: () => void;
};

const contributions = new Map<string, TerminalCommandContribution>();

function validateName(name: string): string {
  const trimmed = name.trim();

  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      `Invalid terminal command name "${name}". Use letters, digits, ".", "_" or "-".`,
    );
  }

  return trimmed;
}

/**
 * Register a command for new Dataverse shell terminals.
 *
 * The returned disposable removes the command again and restores any previous
 * contribution with the same name.
 */
export function registerTerminalCommand(
  contribution: TerminalCommandContribution,
): TerminalCommandDisposable {
  const name = validateName(contribution.name);
  const previous = contributions.get(name);

  contributions.set(name, contribution);

  return {
    dispose(): void {
      if (contributions.get(name) !== contribution) {
        return;
      }

      if (previous != null) {
        contributions.set(name, previous);
      } else {
        contributions.delete(name);
      }
    },
  };
}

export function getTerminalCommandContributions(): TerminalCommandContribution[] {
  return [...contributions.values()];
}
