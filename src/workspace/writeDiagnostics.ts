/*
 * Temporary output-write diagnostics.
 *
 * Compares the same payload through:
 *   - vscode.workspace.fs.writeFile (ext host RPC + IFileService + provider)
 *   - the real-folder HTMLFileSystemProvider directly
 *   - raw File System Access handles
 *
 * and splits the raw FSA call into getFileHandle / createWritable / write /
 * close. That separates the extension-host layer from the filesystem commit.
 */

import type * as vscodeType from "vscode";

import { provider } from "./fsProvider.js";
import { ensureWorkspaceDirectory } from "./workspaceFs.js";

const DIAG_PREFIX = "ide-write-diag";
const DOT_PREFIX = ".ide-write-diag";
const PAYLOAD_BYTES = 782_416;

type WriteTiming = {
  handleMs: number;
  openMs: number;
  writeMs: number;
  closeMs: number;
  totalMs: number;
};

type ResultLine = {
  label: string;
  timing: WriteTiming;
};

function makeBytes(size: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(size);

  bytes.fill(fill);

  return bytes;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function timing(totalMs: number): WriteTiming {
  return { handleMs: 0, openMs: 0, writeMs: 0, closeMs: 0, totalMs };
}

function formatTiming(timing: WriteTiming): string {
  return (
    `total ${round(timing.totalMs)}ms ` +
    `(handle ${round(timing.handleMs)}, open ${round(timing.openMs)}, ` +
    `write ${round(timing.writeMs)}, close ${round(timing.closeMs)})`
  );
}

async function timedRawWrite(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array,
): Promise<WriteTiming> {
  const started = performance.now();
  const handle = await directory.getFileHandle(fileName, { create: true });
  const handled = performance.now();
  const writable = await handle.createWritable();
  const opened = performance.now();

  await writable.write(bytes as Uint8Array<ArrayBuffer>);

  const written = performance.now();

  await writable.close();

  const closed = performance.now();

  return {
    handleMs: handled - started,
    openMs: opened - handled,
    writeMs: written - opened,
    closeMs: closed - written,
    totalMs: closed - started,
  };
}

async function timedFullStackWrite(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
  bytes: Uint8Array,
): Promise<WriteTiming> {
  const started = performance.now();

  await vscode.workspace.fs.writeFile(uri, bytes);

  return timing(performance.now() - started);
}

async function timedProviderWrite(uri: vscodeType.Uri, bytes: Uint8Array): Promise<WriteTiming> {
  const started = performance.now();

  await provider.writeFile(uri, bytes, {
    create: true,
    overwrite: true,
    unlock: false,
    atomic: false,
  });

  return timing(performance.now() - started);
}

async function directoryHandleForPath(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let current = root;

  for (const segment of path.split("/").filter((part) => part.length > 0)) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }

  return current;
}

async function removeQuietly(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch {
    // Nothing to remove.
  }
}

export async function diagnoseOutputWrites(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  workspace: FileSystemDirectoryHandle,
  outdir: string,
  outputPath: string,
  outputBytes?: Uint8Array,
): Promise<string[]> {
  const lines: string[] = [];
  const results: ResultLine[] = [];
  const normalizedOutdir = outdir.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const outDirUri = vscode.Uri.joinPath(
    workspaceRootUri,
    ...normalizedOutdir.split("/").filter((part) => part.length > 0),
  );
  const outDirHandle = await directoryHandleForPath(workspace, normalizedOutdir);
  const htmlBytes = makeBytes(PAYLOAD_BYTES, 0x3c);
  const binBytes = makeBytes(PAYLOAD_BYTES, 0x5a);
  const htmlName = `${DIAG_PREFIX}.html`;
  const binName = `${DIAG_PREFIX}.bin`;
  const dotHtmlName = `${DOT_PREFIX}.html`;
  const providerName = `${DIAG_PREFIX}-provider.html`;
  const fullStackName = `${DIAG_PREFIX}-full.html`;
  const fullStackUri = vscode.Uri.joinPath(outDirUri, fullStackName);
  const providerUri = vscode.Uri.joinPath(outDirUri, providerName);
  const normalizedOutput = outputPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const outputBaseName = normalizedOutput.split("/").pop() ?? "";
  const outputUri = vscode.Uri.joinPath(
    workspaceRootUri,
    ...normalizedOutput.split("/").filter((part) => part.length > 0),
  );
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === outputUri.toString(),
  );

  lines.push(`user agent: ${navigator.userAgent}`);
  lines.push(
    `target: ${normalizedOutdir.length > 0 ? normalizedOutdir : "<workspace root>"} ` +
      `(${PAYLOAD_BYTES} bytes per write)`,
  );
  lines.push(
    `actual output: ${normalizedOutput} ` +
      `(open=${openDocument != null}, dirty=${openDocument?.isDirty === true})`,
  );

  try {
    const ensureStarted = performance.now();

    await ensureWorkspaceDirectory(vscode, outDirUri);

    lines.push(`ensure output directory: ${round(performance.now() - ensureStarted)}ms`);

    await Promise.all([
      removeQuietly(outDirHandle, htmlName),
      removeQuietly(outDirHandle, binName),
      removeQuietly(outDirHandle, dotHtmlName),
      removeQuietly(outDirHandle, providerName),
      removeQuietly(outDirHandle, fullStackName),
    ]);

    let actualBytes = outputBytes;

    if (actualBytes != null) {
      lines.push(`actual output payload: last bundle (${actualBytes.length} bytes)`);
    } else {
      const readStarted = performance.now();

      try {
        actualBytes = await vscode.workspace.fs.readFile(outputUri);
        lines.push(`actual output read: ${round(performance.now() - readStarted)}ms`);
      } catch {
        lines.push("actual output read: missing");
      }
    }

    if (actualBytes != null && outputBaseName.length > 0 && openDocument?.isDirty !== true) {
      results.push({
        label: "actual output full stack #1 (same bytes)",
        timing: await timedFullStackWrite(vscode, outputUri, actualBytes),
      });
      results.push({
        label: "actual output full stack #2 (same bytes)",
        timing: await timedFullStackWrite(vscode, outputUri, actualBytes),
      });
      results.push({
        label: "actual output raw FSA #1 (same bytes)",
        timing: await timedRawWrite(outDirHandle, outputBaseName, actualBytes),
      });
      results.push({
        label: "actual output raw FSA #2 (same bytes)",
        timing: await timedRawWrite(outDirHandle, outputBaseName, actualBytes),
      });

      const deleteStarted = performance.now();

      try {
        if (openDocument != null) {
          throw new Error("output is open in an editor");
        }

        await vscode.workspace.fs.delete(outputUri);

        const deleteMs = performance.now() - deleteStarted;
        const recreateTiming = await timedFullStackWrite(vscode, outputUri, actualBytes);

        results.push({
          label: `actual output delete ${round(deleteMs)}ms + full stack`,
          timing: recreateTiming,
        });
      } catch {
        lines.push("actual output delete + recreate: unavailable");
      }

      /*
       * A temp-write + rename can avoid opening a writable stream on the
       * existing output file. If this is fast while a direct overwrite is
       * slow, the HTML writer can use the same replace strategy.
       */
      const tempName = `${outputBaseName}.diag-tmp`;
      const tempUri = vscode.Uri.joinPath(outDirUri, tempName);

      try {
        const tempStarted = performance.now();

        await vscode.workspace.fs.writeFile(tempUri, actualBytes);

        const tempMs = performance.now() - tempStarted;
        const renameStarted = performance.now();

        await vscode.workspace.fs.rename(tempUri, outputUri, { overwrite: true });

        results.push({
          label: `actual output temp write ${round(tempMs)}ms + rename`,
          timing: timing(performance.now() - renameStarted),
        });
      } catch {
        lines.push("actual output temp write + rename: unavailable");
      } finally {
        await removeQuietly(outDirHandle, tempName);
      }
    }

    results.push({
      label: "full stack .html (new)",
      timing: await timedFullStackWrite(vscode, fullStackUri, htmlBytes),
    });
    results.push({
      label: "full stack .html (overwrite)",
      timing: await timedFullStackWrite(vscode, fullStackUri, htmlBytes),
    });

    const statStarted = performance.now();

    await vscode.workspace.fs.stat(fullStackUri);

    results.push({
      label: "full stack stat after write",
      timing: timing(performance.now() - statStarted),
    });

    results.push({
      label: "real provider .html (new)",
      timing: await timedProviderWrite(providerUri, htmlBytes),
    });
    results.push({
      label: "real provider .html (overwrite)",
      timing: await timedProviderWrite(providerUri, htmlBytes),
    });

    results.push({
      label: "raw FSA 782 KB .html (new)",
      timing: await timedRawWrite(outDirHandle, htmlName, htmlBytes),
    });
    results.push({
      label: "raw FSA 782 KB .html (overwrite)",
      timing: await timedRawWrite(outDirHandle, htmlName, htmlBytes),
    });
    results.push({
      label: "raw FSA 782 KB dot-.html (new)",
      timing: await timedRawWrite(outDirHandle, dotHtmlName, htmlBytes),
    });
    results.push({
      label: "raw FSA 782 KB dot-.html (overwrite)",
      timing: await timedRawWrite(outDirHandle, dotHtmlName, htmlBytes),
    });
    results.push({
      label: "raw FSA 782 KB .bin (new)",
      timing: await timedRawWrite(outDirHandle, binName, binBytes),
    });
    results.push({
      label: "raw FSA 782 KB .bin (overwrite)",
      timing: await timedRawWrite(outDirHandle, binName, binBytes),
    });
  } finally {
    await Promise.all([
      removeQuietly(outDirHandle, htmlName),
      removeQuietly(outDirHandle, binName),
      removeQuietly(outDirHandle, dotHtmlName),
      removeQuietly(outDirHandle, providerName),
      removeQuietly(outDirHandle, fullStackName),
    ]);
  }

  try {
    const opfsRoot = await navigator.storage.getDirectory();
    const opfs = await opfsRoot.getDirectoryHandle(DIAG_PREFIX, { create: true });

    results.push({
      label: "OPFS 782 KB .html (new)",
      timing: await timedRawWrite(opfs, htmlName, htmlBytes),
    });
    results.push({
      label: "OPFS 782 KB .html (overwrite)",
      timing: await timedRawWrite(opfs, htmlName, htmlBytes),
    });

    await opfsRoot.removeEntry(DIAG_PREFIX, { recursive: true }).catch(() => undefined);
  } catch {
    lines.push("OPFS comparison: unavailable");
  }

  for (const result of results) {
    lines.push(`${result.label}: ${formatTiming(result.timing)}`);
  }

  lines.push(
    "note: if full stack is slow but the real provider is fast, the cost is IFileService/RPC. " +
      "If close() is slow on the real folder but not OPFS, the cost is the filesystem/sync/AV commit.",
  );

  return lines;
}
