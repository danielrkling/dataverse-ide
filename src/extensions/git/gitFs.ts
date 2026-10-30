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
 * Chromium blocks direct creation/access of `.git/hooks` through the File
 * System Access API. isomorphic-git creates this conventional directory
 * during init but does not execute native Git hooks, so store it under a
 * safe physical directory name instead.
 */
const GIT_METADATA_DIR = '.git'
const GIT_HOOKS_DIR = 'hooks'
const SAFE_GIT_HOOKS_DIR = '_hooks'

function toPathParts(path: string): string[] {
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

  /*
   * Logical Git path:
   *   .git/hooks/pre-commit
   *
   * Physical browser-accessed path:
   *   .git/_dataverse_ide_hooks/pre-commit
   */
  if (parts[0] === GIT_METADATA_DIR && parts[1] === GIT_HOOKS_DIR) {
    parts[1] = SAFE_GIT_HOOKS_DIR
  }

  return parts
}

function fromStorageEntryName(parentPath: string, name: string): string {
  const parentParts = parentPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')

  /*
   * Physical:
   *   .git/_dataverse_ide_hooks
   *
   * Logical Git-facing view:
   *   .git/hooks
   */
  if (
    parentParts.length === 1 &&
    parentParts[0] === GIT_METADATA_DIR &&
    name === SAFE_GIT_HOOKS_DIR
  ) {
    return GIT_HOOKS_DIR
  }

  return name
}

async function getDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let directory = root

  try {
    for (const part of toPathParts(path)) {
      directory = await directory.getDirectoryHandle(part)
    }

    return directory
  } catch {
    throw createFsError('ENOENT', path)
  }
}

async function getOrCreateDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let directory = root

  for (const part of toPathParts(path)) {
    directory = await directory.getDirectoryHandle(part, {
      create: true,
    })
  }

  return directory
}

async function getParentDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<{
  parent: FileSystemDirectoryHandle
  name: string
}> {
  const parts = toPathParts(path)
  const name = parts.pop()

  if (name == null) {
    throw createFsError('EISDIR', path)
  }

  return {
    parent: await getDirectoryHandle(root, parts.join('/')),
    name,
  }
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemFileHandle> {
  try {
    const { parent, name } = await getParentDirectoryHandle(root, path)

    return await parent.getFileHandle(name)
  } catch {
    throw createFsError('ENOENT', path)
  }
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
) {
  return {
    promises: {
      async readFile(path: string, options?: Encoding) {
        const handle = await getFileHandle(root, path)
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
        const { parent, name } = await getParentDirectoryHandle(root, path)

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
        const directory = await getDirectoryHandle(root, path)
        const entries: string[] = []
      
        for await (const [name] of directory.entries()) {
          entries.push(fromStorageEntryName(path, name))
        }
      
        return entries.sort((left, right) => left.localeCompare(right))
      },

      async mkdir(path: string): Promise<void> {
        /*
         * isomorphic-git creates .git/objects, .git/refs, lock-file parents,
         * and similar directories. Recursive creation is safe here.
         */
        await getOrCreateDirectoryHandle(root, path)
      },

      async rmdir(path: string): Promise<void> {
        const { parent, name } = await getParentDirectoryHandle(root, path)

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
        const { parent, name } = await getParentDirectoryHandle(root, path)

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
          const handle = await getFileHandle(root, path)
          const file = await handle.getFile()

          return createStats('file', file)
        } catch {
          try {
            await getDirectoryHandle(root, path)

            return createStats('directory')
          } catch {
            throw createFsError('ENOENT', path)
          }
        }
      },

      async lstat(path: string): Promise<GitStats> {
        try {
          const handle = await getFileHandle(root, path)
          const file = await handle.getFile()

          return createStats('file', file)
        } catch {
          try {
            await getDirectoryHandle(root, path)

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