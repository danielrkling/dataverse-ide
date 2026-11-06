/*
 * Shared output channel between the shell commands and the pseudoterminal.
 *
 * The terminal can stream a running `node` command directly to the pty.
 * Commands that need their output captured (pipelines, redirects, nested
 * `npm run` scripts) leave streaming off and return stdout normally.
 */

export type ShellOutput = {
  write: (data: string) => void;
  isStreaming: () => boolean;
  bind: (writer: (data: string) => void) => void;
  setStreaming: (value: boolean) => void;
};

export function createShellOutput(): ShellOutput {
  let writer: ((data: string) => void) | undefined;
  let streaming = false;

  return {
    write(data: string): void {
      writer?.(data);
    },

    isStreaming(): boolean {
      return streaming;
    },

    bind(nextWriter: (data: string) => void): void {
      writer = nextWriter;
    },

    setStreaming(value: boolean): void {
      streaming = value;
    },
  };
}
