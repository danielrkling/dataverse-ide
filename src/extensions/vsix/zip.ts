/*
 * Minimal ZIP reader for VSIX packages.
 *
 * A VSIX is a plain ZIP archive. We only need the file contents, so this
 * parser reads the central directory and supports the two compression
 * methods used by VSIX tooling:
 *
 *   - 0 (stored)
 *   - 8 (deflate, decompressed with the browser-native DecompressionStream)
 *
 * ZIP64 archives are rejected with a clear error instead of being parsed
 * incorrectly. VSIX files are far below the ZIP64 limits in practice.
 */

export type ZipEntry = {
  path: string;
  directory: boolean;
  content?: Uint8Array;
};

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const MAX_ENTRIES = 20_000;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - 22 - 0xffff);

  for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      const commentLength = view.getUint16(offset + 20, true);

      // Prefer the record whose comment runs exactly to the end of the file.
      if (offset + 22 + commentLength === view.byteLength) {
        return offset;
      }
    }
  }

  // Tolerate trailing bytes after a valid record (some tools append them).
  for (let offset = view.byteLength - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }

  throw new Error("Not a ZIP archive: end of central directory record not found.");
}

function decodeName(bytes: Uint8Array): string {
  // VSIX tooling writes UTF-8 names (and sets the UTF-8 flag). Non-ASCII
  // legacy CP437 names are not used by extension packages, so UTF-8 is enough.
  return new TextDecoder("utf-8").decode(bytes);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const copy = data.slice();
  const stream = new Blob([copy.buffer])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read every file entry from a ZIP archive.
 *
 * Directory entries are returned with `directory: true` and no content. The
 * caller decides which paths are relevant (VSIX files live under
 * `extension/`, but we keep parsing generic).
 */
export async function unzip(data: Uint8Array): Promise<ZipEntry[]> {
  if (data.byteLength < 22) {
    throw new Error("Not a ZIP archive: file is too small.");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const endOffset = findEndOfCentralDirectory(view);

  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnThisDisk = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnThisDisk !== totalEntries) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }

  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are not supported.");
  }

  if (totalEntries > MAX_ENTRIES) {
    throw new Error(`ZIP archive has too many entries (${totalEntries}).`);
  }

  if (centralDirectoryOffset + centralDirectorySize > data.byteLength) {
    throw new Error("ZIP archive is truncated or corrupt.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > data.byteLength) {
      throw new Error("ZIP central directory is truncated.");
    }

    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP central directory entry has an invalid signature.");
    }

    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd + extraLength + commentLength > data.byteLength) {
      throw new Error("ZIP central directory entry is truncated.");
    }

    const name = decodeName(data.subarray(nameStart, nameEnd));

    offset = nameEnd + extraLength + commentLength;

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported.");
    }

    if ((flags & 0x0001) !== 0) {
      throw new Error(`Encrypted ZIP entries are not supported (${name}).`);
    }

    const directory = name.endsWith("/") || name.endsWith("\\");

    if (directory) {
      entries.push({ path: name, directory: true });
      continue;
    }

    totalUncompressedBytes += uncompressedSize;

    if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("ZIP archive is too large after decompression.");
    }

    if (localHeaderOffset + 30 > data.byteLength) {
      throw new Error(`ZIP local header is truncated (${name}).`);
    }

    if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`ZIP local header has an invalid signature (${name}).`);
    }

    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > data.byteLength) {
      throw new Error(`ZIP entry data is truncated (${name}).`);
    }

    let content: Uint8Array;

    if (compressionMethod === 0) {
      content = data.slice(dataStart, dataEnd);
    } else if (compressionMethod === 8) {
      content = await inflateRaw(data.subarray(dataStart, dataEnd));
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for entry "${name}".`,
      );
    }

    if (content.byteLength !== uncompressedSize) {
      throw new Error(
        `ZIP entry "${name}" has an unexpected size (${content.byteLength} vs ${uncompressedSize}).`,
      );
    }

    entries.push({ path: name, directory: false, content });
  }

  return entries;
}

/** Normalize a ZIP path and reject absolute/traversal paths. */
export function normalizeZipPath(path: string): string {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");

  if (parts.some((part) => part === "..")) {
    throw new Error(`Unsafe path in ZIP archive: ${path}`);
  }

  return parts.join("/");
}
