type Encoding =
  | string
  | {
      encoding?: string | null
    }
  | undefined

type GitStats = {
  size: number
  mode: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

type FileData =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array

type GitFsOptions = {
  /*
   * Physical directory used for Git metadata. Defaults to `.git`. A
   * non-reserved name such as `_git` avoids Chromium's File System Access
   * write blocklist. Sensitive entries keep their safe physical names under
   * either directory, so renaming `.git` to `_git` preserves existing repos.
   */
  metadataDirectoryName?: string
}

function createFsError(
  code:
    | 'EACCES'
    | 'EEXIST'
    | 'EISDIR'
    | 'ENOENT'
    | 'ENOSYS'
    | 'ENOTDIR'
    | 'ENOTEMPTY',
  path: string,
): Error & { code: string } {
  const error = new Error(`${code}: ${path}`) as Error & {
    code: string
  }

  error.code = code

  return error
}

function getEncoding(options: Encoding): string | undefined {
  if (typeof options === 'string') {
    return options
  }

  return options?.encoding ?? undefined
}

/*
 * Chromium's File System Access blocklist denies writes to sensitive paths
 * inside any `.git` directory:
 *
 *   .git/hooks
 *   .git/config
 *   .git/modules
 *
 * isomorphic-git creates `.git/config` during init and rewrites it for remote
 * operations, so store these entries under safe physical names instead. Reads
 * remain allowed; the rename is what keeps writes working. `_hooks` is kept
 * for repositories initialized by earlier versions.
 *
 * The remapping is applied under any configured metadata directory name, so
 * renaming `.git` to an alternate name such as `_git` keeps existing
 * repositories readable. Only the literal `.git` name is subject to
 * Chromium's blocklist; alternate names avoid it entirely.
 */
const DEFAULT_GIT_METADATA_DIR_NAME = '.git'

const GIT_BLOCKED_ENTRY_NAMES = new Map<string, string>([
  ['hooks', '_hooks'],
  ['config', '_config'],
  ['modules', '_modules'],
])

function normalizeMetadataDirectoryName(name: string | undefined): string {
  const trimmed = name?.trim()

  if (
    trimmed == null ||
    trimmed.length === 0 ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    return DEFAULT_GIT_METADATA_DIR_NAME
  }

  return trimmed
}

function toLegacyPathParts(path: string): string[] {
  const parts = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')

  /*
   * The Git adapter must never escape the browser-selected folder.
   */
  if (parts.some((part) => part === '..')) {
    throw createFsError('EACCES', path)
  }

  return parts
}

function toPathParts(
  path: string,
  metadataDirectoryName: string,
): string[] {
  const parts = toLegacyPathParts(path)

  /*
   * Logical Git path:
   *   .git/config
   *
   * Physical browser-accessed path:
   *   .git/_config
   */
  if (parts[0] === metadataDirectoryName && parts.length > 1) {
    const safeName = GIT_BLOCKED_ENTRY_NAMES.get(parts[1])

    if (safeName != null) {
      parts[1] = safeName
    }
  }

  return parts
}

/*
 * Repositories created before a path was added to the blocklist may still
 * contain it under its real name. Reads stay allowed, so look there as a
 * fallback while new writes always go to the safe physical name.
 */
function getPathPartsCandidates(
  path: string,
  metadataDirectoryName: string,
): string[][] {
  const parts = toPathParts(path, metadataDirectoryName)
  const legacyParts = toLegacyPathParts(path)

  if (
    parts.length === legacyParts.length &&
    parts.every((part, index) => part === legacyParts[index])
  ) {
    return [parts]
  }

  return [parts, legacyParts]
}

function fromStorageEntryName(
  parentPath: string,
  name: string,
  metadataDirectoryName: string,
): string {
  const parentParts = parentPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')

  /*
   * Physical:
   *   .git/_config
   *
   * Logical Git-facing view:
   *   .git/config
   */
  if (
    parentParts.length === 1 &&
    parentParts[0] === metadataDirectoryName
  ) {
    for (const [logicalName, safeName] of GIT_BLOCKED_ENTRY_NAMES) {
      if (name === safeName) {
        return logicalName
      }
    }
  }

  return name
}

async function getDirectoryHandleFromParts(
  root: FileSystemDirectoryHandle,
  parts: string[],
): Promise<FileSystemDirectoryHandle> {
  let directory = root

  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part)
  }

  return directory
}

async function getDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  metadataDirectoryName: string,
): Promise<FileSystemDirectoryHandle> {
  for (const parts of getPathPartsCandidates(path, metadataDirectoryName)) {
    try {
      return await getDirectoryHandleFromParts(root, parts)
    } catch {
      /* try the next physical path */
    }
  }

  throw createFsError('ENOENT', path)
}

async function getOrCreateDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  metadataDirectoryName: string,
): Promise<FileSystemDirectoryHandle> {
  let directory = root

  for (const part of toPathParts(path, metadataDirectoryName)) {
    directory = await directory.getDirectoryHandle(part, {
      create: true,
    })
  }

  return directory
}

async function getParentDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  metadataDirectoryName: string,
): Promise<{
  parent: FileSystemDirectoryHandle
  name: string
}> {
  const parts = toPathParts(path, metadataDirectoryName)
  const name = parts.pop()

  if (name == null) {
    throw createFsError('EISDIR', path)
  }

  return {
    /*
     * writeFile/rmdir/unlink must target the safe physical entry even when a
     * legacy, now-write-blocked entry still exists under the real name.
     */
    parent: await getDirectoryHandleFromParts(root, parts),
    name,
  }
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  metadataDirectoryName: string,
): Promise<FileSystemFileHandle> {
  for (const parts of getPathPartsCandidates(path, metadataDirectoryName)) {
    const name = parts.pop()

    if (name == null) {
      continue
    }

    try {
      const parent = await getDirectoryHandleFromParts(root, parts)

      return await parent.getFileHandle(name)
    } catch {
      /* try the next physical path */
    }
  }

  throw createFsError('ENOENT', path)
}

function createStats(
  kind: 'file' | 'directory',
  file?: File,
): GitStats {
  const isFile = kind === 'file'
  const timestamp = file?.lastModified ?? Date.now()

  return {
    size: file?.size ?? 0,

    /*
     * Browser File System Access does not expose POSIX modes. Use the common
     * non-executable file mode and directory mode expected by Git tooling.
     */
    mode: isFile ? 0o100644 : 0o040755,

    mtimeMs: timestamp,
    ctimeMs: timestamp,
    birthtimeMs: timestamp,

    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
  }
}

function normalizeWriteData(
    data: FileData,
  ): string | ArrayBuffer | Uint8Array<ArrayBuffer> {
    if (typeof data === 'string') {
      return data
    }
  
    if (data instanceof ArrayBuffer) {
      return data
    }
  
    /*
     * Copy into a new ordinary ArrayBuffer-backed Uint8Array.
     *
     * TypeScript distinguishes ArrayBuffer from SharedArrayBuffer. Creating a
     * fresh Uint8Array ensures the File System Access API receives a supported
     * BufferSource regardless of the original typed-array backing store.
     */
    const source = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    )
  
    const copy = new Uint8Array(source.byteLength)
  
    copy.set(source)
  
    return copy
  }

export function createFileSystemAccessGitFs(
  root: FileSystemDirectoryHandle,
  options?: GitFsOptions,
) {
  const metadataDirectoryName = normalizeMetadataDirectoryName(
    options?.metadataDirectoryName,
  )

  return {
    promises: {
      async readFile(path: string, options?: Encoding) {
        const handle = await getFileHandle(
          root,
          path,
          metadataDirectoryName,
        )
        const file = await handle.getFile()
        const data = new Uint8Array(await file.arrayBuffer())

        const encoding = getEncoding(options)?.toLowerCase()

        if (encoding === 'utf8' || encoding === 'utf-8') {
          return new TextDecoder('utf-8').decode(data)
        }

        if (encoding === 'utf16le' || encoding === 'utf-16le') {
          return new TextDecoder('utf-16le').decode(data)
        }

        return data
      },

      async writeFile(
        path: string,
        data: FileData,
        _options?: Encoding,
      ): Promise<void> {
        const { parent, name } = await getParentDirectoryHandle(
          root,
          path,
          metadataDirectoryName,
        )

        const handle = await parent.getFileHandle(name, {
          create: true,
        })

        const writable = await handle.createWritable()

        try {
          await writable.write(normalizeWriteData(data))
        } finally {
          await writable.close()
        }
      },

      async readdir(path: string): Promise<string[]> {
        const directory = await getDirectoryHandle(
          root,
          path,
          metadataDirectoryName,
        )
        const entries = new Set<string>()

        for await (const [name] of directory.entries()) {
          entries.add(
            fromStorageEntryName(path, name, metadataDirectoryName),
          )
        }

        return [...entries].sort((left, right) => left.localeCompare(right))
      },

      async mkdir(path: string): Promise<void> {
        /*
         * isomorphic-git creates the metadata directory, objects, refs,
         * lock-file parents, and similar directories. Recursive creation is
         * safe here.
         */
        await getOrCreateDirectoryHandle(
          root,
          path,
          metadataDirectoryName,
        )
      },

      async rmdir(path: string): Promise<void> {
        const { parent, name } = await getParentDirectoryHandle(
          root,
          path,
          metadataDirectoryName,
        )

        try {
          await parent.removeEntry(name, {
            recursive: false,
          })
        } catch (error) {
          if (
            error instanceof DOMException &&
            error.name === 'InvalidModificationError'
          ) {
            throw createFsError('ENOTEMPTY', path)
          }

          throw createFsError('ENOENT', path)
        }
      },

      async unlink(path: string): Promise<void> {
        const { parent, name } = await getParentDirectoryHandle(
          root,
          path,
          metadataDirectoryName,
        )

        try {
          await parent.removeEntry(name, {
            recursive: false,
          })
        } catch {
          throw createFsError('ENOENT', path)
        }
      },

      async stat(path: string): Promise<GitStats> {
        try {
          const handle = await getFileHandle(
            root,
            path,
            metadataDirectoryName,
          )
          const file = await handle.getFile()

          return createStats('file', file)
        } catch {
          try {
            await getDirectoryHandle(
              root,
              path,
              metadataDirectoryName,
            )

            return createStats('directory')
          } catch {
            throw createFsError('ENOENT', path)
          }
        }
      },

      async lstat(path: string): Promise<GitStats> {
        try {
          const handle = await getFileHandle(
            root,
            path,
            metadataDirectoryName,
          )
          const file = await handle.getFile()

          return createStats('file', file)
        } catch {
          try {
            await getDirectoryHandle(
              root,
              path,
              metadataDirectoryName,
            )

            return createStats('directory')
          } catch {
            throw createFsError('ENOENT', path)
          }
        }
      },

      async readlink(path: string): Promise<string> {
        throw createFsError('ENOSYS', path)
      },

      async symlink(
        _target: string,
        path: string,
      ): Promise<void> {
        throw createFsError('ENOSYS', path)
      },
    },
  }
}