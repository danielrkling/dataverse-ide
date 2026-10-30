/*
 * Tarball extraction that writes directly to the workspace filesystem.
 *
 * Ported from almostnode's npm/tarball.ts (MIT, by Macaly/almostnode).
 * Decompression uses the browser-native DecompressionStream instead of pako,
 * and files land in vscode.workspace.fs - no VirtualFS round-trip, no
 * duplicate writes (see todo.md on OneDrive flagging node_modules).
 */

export interface TarEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'unknown'
  size: number
  content?: Uint8Array
  linkTarget?: string
}

export function* parseTar(data: Uint8Array): Generator<TarEntry> {
  const decoder = new TextDecoder()
  let offset = 0

  while (offset < data.length - 512) {
    const header = data.subarray(offset, offset + 512)
    offset += 512

    // Two zero blocks mark the end of the archive.
    if (header.every((byte) => byte === 0)) {
      break
    }

    const name = parseTarString(header, 0, 100)
    const size = parseTarOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156])
    const linkName = parseTarString(header, 157, 100)
    const prefix = parseTarString(header, 345, 155)

    if (!name) {
      continue
    }

    const fullName = prefix ? `${prefix}/${name}` : name

    let type: TarEntry['type']
    switch (typeFlag) {
      case '0':
      case '\0':
      case '':
        type = 'file'
        break
      case '5':
        type = 'directory'
        break
      case '1':
      case '2':
        type = 'symlink'
        break
      default:
        type = 'unknown'
    }

    let content: Uint8Array | undefined

    if (type === 'file') {
      content = size > 0 ? data.subarray(offset, offset + size) : new Uint8Array(0)

      if (size > 0) {
        offset += Math.ceil(size / 512) * 512
      }
    }

    yield {
      name: fullName,
      type,
      size,
      content,
      linkTarget: type === 'symlink' ? linkName : undefined,
    }
  }
}

function parseTarString(data: Uint8Array, offset: number, length: number): string {
  const bytes = data.subarray(offset, offset + length)
  const nullIndex = bytes.indexOf(0)

  return new TextDecoder().decode(
    nullIndex >= 0 ? bytes.subarray(0, nullIndex) : bytes,
  )
}

function parseTarOctal(data: Uint8Array, offset: number, length: number): number {
  const text = parseTarString(data, offset, length).trim()

  return parseInt(text, 8) || 0
}

/*
 * Decompress a gzip stream with the runtime-native API (browser
 * DecompressionStream; also available in Node 18+ for the sanity harnesses).
 */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const compressed = data.slice().buffer as ArrayBuffer

  const decompressed = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))

  return new Uint8Array(await new Response(decompressed).arrayBuffer())
}
