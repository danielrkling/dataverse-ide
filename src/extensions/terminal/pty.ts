/*
 * Extension-owned pseudoterminal for the Dataverse shell.
 *
 * The terminal service in VS Code expects a pty host, but extension-owned
 * pseudoterminals bypass that and give us input/output directly. This is a
 * line-oriented editor (no job control / full-screen apps - just-bash is not
 * a real PTY).
 */

import type * as vscodeType from "vscode";

import type { CustomCommand } from "just-bash";

import type { ShellFs } from "./shellFs.js";
import type { ShellHistory } from "./history.js";
import type { ShellOutput } from "./output.js";
import type { ShellSession } from "./shell.js";

const BANNER = [
  "Dataverse shell - workspace-backed just-bash",
  "Commands run against the real workspace filesystem. Type `help` for shell commands,",
  "`node <file>` to run a file, or `npm run <script>`.",
  "",
].join("\r\n");

const PROMPT_COLOR = "\x1b[1;32m";
const PROMPT_RESET = "\x1b[0m";

type PtyOptions = {
  vscode: typeof vscodeType;
  fs: ShellFs;
  output: ShellOutput;
  history?: ShellHistory;
  commands: CustomCommand[];
};

/*
 * Stream top-level `node` commands straight to the pty. Pipelines and
 * redirects must keep their output buffered so the shell can route it.
 */
function shouldStreamCommand(commandLine: string): boolean {
  const trimmed = commandLine.trim();

  return /(?:^|[\s;&])node(?:\s|$)/.test(trimmed) && !/[|<>]/.test(trimmed);
}

export class DataverseShellPty implements vscodeType.Pseudoterminal {
  private readonly writeEmitter: vscodeType.EventEmitter<string>;
  private readonly closeEmitter: vscodeType.EventEmitter<void | number>;

  readonly onDidWrite: vscodeType.Event<string>;
  readonly onDidClose: vscodeType.Event<void | number>;

  private session: ShellSession | undefined;
  private line = "";
  private history: string[] = [];
  private historyIndex = 0;
  private busy = false;
  private disposed = false;
  private pendingInput = "";
  private controller: AbortController | undefined;
  private dimensions: vscodeType.TerminalDimensions | undefined;

  constructor(private readonly options: PtyOptions) {
    this.writeEmitter = new options.vscode.EventEmitter<string>();
    this.closeEmitter = new options.vscode.EventEmitter<void | number>();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
    options.output.bind((data) => this.write(data));
  }

  open(initialDimensions: vscodeType.TerminalDimensions | undefined): void {
    this.dimensions = initialDimensions;
    this.write(BANNER);
    void this.initialize();
  }

  close(): void {
    this.disposed = true;
    this.controller?.abort();
    this.session?.dispose();
    this.session = undefined;
    void this.options.history?.flush();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  handleInput(data: string): void {
    if (this.disposed) {
      return;
    }

    /*
     * While a command is running the shell has no stdin streaming, so the
     * only useful key is Ctrl-C. just-bash's abort signal stops the
     * interpreter at the next statement boundary.
     */
    if (this.busy) {
      if (data.includes("\x03")) {
        this.controller?.abort();
        this.write("^C\r\n");
      }

      return;
    }

    if (this.session == null) {
      /*
       * The terminal can receive input (for example `terminal.sendText`)
       * before the async initialization finishes. Hold it until the prompt
       * exists instead of dropping it.
       */
      this.pendingInput += data;

      return;
    }

    const chars = [...data];

    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];

      if (char === "\x1b" && chars[index + 1] === "[") {
        const code = chars[index + 2];
        index += 2;

        if (code === "A") {
          this.historyPrevious();
        } else if (code === "B") {
          this.historyNext();
        }

        continue;
      }

      if (char === "\r" || char === "\n") {
        const command = this.line;

        this.line = "";
        this.write("\r\n");
        this.submit(command);

        /*
         * A paste can contain multiple lines. Keep the rest of the batch for
         * after the current command instead of starting concurrent commands.
         */
        if (this.busy) {
          this.pendingInput += chars.slice(index + 1).join("");
          break;
        }

        continue;
      }

      if (char === "\x7f" || char === "\b") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.write("\b \b");
        }

        continue;
      }

      if (char === "\x03") {
        this.line = "";
        this.write("^C\r\n");
        this.prompt();
        continue;
      }

      if (char === "\x04") {
        if (this.line.length === 0) {
          this.closeEmitter.fire(0);
        }

        continue;
      }

      if (char === "\x15") {
        this.line = "";
        this.redrawLine();
        continue;
      }

      if (char === "\x0c") {
        this.write("\x1b[2J\x1b[H");
        this.redrawLine();
        continue;
      }

      if (char < " ") {
        continue;
      }

      this.line += char;
      this.write(char);
    }
  }

  setDimensions(dimensions: vscodeType.TerminalDimensions): void {
    this.dimensions = dimensions;
  }

  private async initialize(): Promise<void> {
    try {
      await this.options.fs.ready();
    } catch {
      /* A stale path index only affects globs; continue with the shell. */
    }

    if (this.disposed || this.session != null) {
      return;
    }

    try {
      /*
       * Load just-bash on first terminal use instead of extension activation.
       */
      const { createShellSession } = await import("./shell.js");

      this.session = createShellSession({
        fs: this.options.fs,
        cwd: "/",
        commands: this.options.commands,
      });

      if (this.options.history != null) {
        try {
          this.history = await this.options.history.load();
          this.historyIndex = this.history.length;
        } catch {
          /* History is optional. */
        }
      }

      this.prompt();

      const pending = this.pendingInput;

      this.pendingInput = "";

      if (pending.length > 0) {
        this.handleInput(pending);
      }
    } catch (error) {
      this.write(
        `\r\nCould not start the shell: ${
          error instanceof Error ? error.message : String(error)
        }\r\n`,
      );
    }
  }

  private submit(commandLine: string): void {
    if (this.busy) {
      return;
    }

    const command = commandLine.trim();

    if (command.length === 0) {
      this.prompt();

      return;
    }

    if (command === "exit" || command === "logout") {
      this.closeEmitter.fire(0);

      return;
    }

    if (command === "clear") {
      this.write("\x1b[2J\x1b[H");
      this.prompt();

      return;
    }

    if (this.history[this.history.length - 1] !== command) {
      this.history.push(command);
      this.options.history?.append(command);
    }

    this.historyIndex = this.history.length;
    void this.execute(command);
  }

  private async execute(command: string): Promise<void> {
    if (this.session == null) {
      return;
    }

    this.busy = true;
    this.controller = new AbortController();
    this.options.output.setStreaming(shouldStreamCommand(command));

    try {
      const result = await this.session.exec(command, this.controller.signal);

      if (result.stdout.length > 0) {
        this.write(result.stdout);
      }

      if (result.stderr.length > 0) {
        this.write(result.stderr);
      }

      const output = result.stdout + result.stderr;

      if (output.length > 0 && !output.endsWith("\n")) {
        this.write("\r\n");
      }
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.write("^C\r\n");
      } else {
        this.write(`\r\n${error instanceof Error ? error.message : String(error)}\r\n`);
      }
    } finally {
      this.busy = false;
      this.controller = undefined;
      this.options.output.setStreaming(false);

      if (!this.disposed) {
        this.prompt();

        const pending = this.pendingInput;

        this.pendingInput = "";

        if (pending.length > 0) {
          this.handleInput(pending);
        }
      }
    }
  }

  private prompt(): void {
    this.write(`${PROMPT_COLOR}${this.session?.cwd ?? "/"}${PROMPT_RESET}$ `);
  }

  private promptText(): string {
    return `${PROMPT_COLOR}${this.session?.cwd ?? "/"}${PROMPT_RESET}$ `;
  }

  private redrawLine(): void {
    this.write(`\r\x1b[2K${this.promptText()}${this.line}`);
  }

  private historyPrevious(): void {
    if (this.history.length === 0 || this.historyIndex <= 0) {
      return;
    }

    this.historyIndex -= 1;
    this.line = this.history[this.historyIndex] ?? "";
    this.redrawLine();
  }

  private historyNext(): void {
    if (this.history.length === 0) {
      return;
    }

    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.line = this.history[this.historyIndex] ?? "";
    } else {
      this.historyIndex = this.history.length;
      this.line = "";
    }

    this.redrawLine();
  }

  private write(data: string): void {
    if (this.disposed) {
      return;
    }

    this.writeEmitter.fire(data.replace(/\r?\n/g, "\r\n"));
  }
}

export type { PtyOptions };
