/*
 * Worker error-event diagnostics helpers (rolldown extension).
 */

/*
 * Flatten a worker ErrorEvent into every clue it carries: ErrorEvent.error
 * is not always an Error instance (DOMException, strings, module-graph
 * failures), and message/lineno/colno sometimes carry details even when
 * .error is stripped by the browser.
 */
export function describeWorkerError(event: ErrorEvent): string {
  const lines: string[] = [];

  if (event.message != null && event.message.length > 0) {
    lines.push(event.message);
  }

  const error = event.error as unknown;

  if (error instanceof Error) {
    lines.push(`${error.message}\n${error.stack ?? ""}`);
  } else if (error != null) {
    try {
      lines.push(`error: ${String(error)}`);
    } catch {
      lines.push("error: <unstringifiable>");
    }
  }

  if (event.filename != null) {
    lines.push(`at ${event.filename}${event.lineno > 0 ? `:${event.lineno}:${event.colno}` : ""}`);
  }

  return lines.length > 0 ? lines.join(" | ") : "unknown error (no message, no error object)";
}
