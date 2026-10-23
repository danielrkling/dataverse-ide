import { openDB } from './db.js'

const DB_NAME = 'dataverse-ide-recents'
const STORE = 'workspaces'

export type LocalWorkspaceRecent = {
  id: string
  kind: 'local'
  name: string
  handle: FileSystemDirectoryHandle
  createdAt: string
  lastOpenedAt: string
}

export type OpfsWorkspaceRecent = {
  id: string
  kind: 'opfs'
  name: string
  opfsDirectoryName: string
  createdAt: string
  lastOpenedAt: string
}

export type RecentWorkspace =
  | LocalWorkspaceRecent
  | OpfsWorkspaceRecent

function now(): string {
  return new Date().toISOString()
}

function makeId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

function normalizeOpfsDirectoryName(name: string): string {
  const normalized = name.trim()

  if (normalized.length === 0) {
    throw new Error('A workspace name is required.')
  }

  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    throw new Error(
      'The workspace name cannot contain slashes or path traversal values.',
    )
  }

  return normalized
}

export async function listRecentWorkspaces(): Promise<
  RecentWorkspace[]
> {
  const db = await openDB(DB_NAME, STORE)

  const records = (await db.getAll(STORE)) as RecentWorkspace[]

  return records.sort((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt),
  )
}

export async function removeRecentWorkspace(
  id: string,
): Promise<void> {
  const db = await openDB(DB_NAME, STORE)

  await db.delete(STORE, id)
}

export async function saveLocalWorkspace(
  handle: FileSystemDirectoryHandle,
): Promise<LocalWorkspaceRecent> {
  const db = await openDB(DB_NAME, STORE)
  const existingRecords = await listRecentWorkspaces()

  /*
   * Avoid duplicate records when the user reopens the same picked folder.
   */
  for (const record of existingRecords) {
    if (record.kind !== 'local') {
      continue
    }

    try {
      if (await record.handle.isSameEntry(handle)) {
        const updated: LocalWorkspaceRecent = {
          ...record,
          name: handle.name,
          lastOpenedAt: now(),
        }

        await db.put(STORE, updated, updated.id)

        return updated
      }
    } catch {
      /*
       * A stale handle may no longer be comparable. Leave it alone; it can be
       * removed by the user from the recent-workspaces list.
       */
    }
  }

  const timestamp = now()

  const record: LocalWorkspaceRecent = {
    id: makeId('local'),
    kind: 'local',
    name: handle.name,
    handle,
    createdAt: timestamp,
    lastOpenedAt: timestamp,
  }

  await db.put(STORE, record, record.id)

  return record
}

export async function saveOpfsWorkspace(
  name: string,
): Promise<OpfsWorkspaceRecent> {
  const db = await openDB(DB_NAME, STORE)

  const opfsDirectoryName = normalizeOpfsDirectoryName(name)
  const id = `opfs:${opfsDirectoryName}`
  const existing = await db.get(STORE, id)

  const timestamp = now()

  const record: OpfsWorkspaceRecent = {
    id,
    kind: 'opfs',
    name: opfsDirectoryName,
    opfsDirectoryName,
    createdAt:
      existing != null
        ? (existing as OpfsWorkspaceRecent).createdAt
        : timestamp,
    lastOpenedAt: timestamp,
  }

  await db.put(STORE, record, record.id)

  return record
}

export function supportsOpfs(): boolean {
  return (
    'storage' in navigator &&
    typeof navigator.storage.getDirectory === 'function'
  )
}

export async function openOpfsWorkspace(
  record: OpfsWorkspaceRecent,
  options?: {
    create?: boolean
  },
): Promise<FileSystemDirectoryHandle> {
  if (!supportsOpfs()) {
    throw new Error(
      'This browser does not support Origin Private File System workspaces.',
    )
  }

  const root = await navigator.storage.getDirectory()

  return root.getDirectoryHandle(record.opfsDirectoryName, {
    create: options?.create ?? false,
  })
}

export async function createOpfsWorkspace(
  name: string,
): Promise<{
  record: OpfsWorkspaceRecent
  handle: FileSystemDirectoryHandle
}> {
  const opfsDirectoryName = normalizeOpfsDirectoryName(name)

  const record = await saveOpfsWorkspace(opfsDirectoryName)

  const handle = await openOpfsWorkspace(record, {
    create: true,
  })

  return {
    record,
    handle,
  }
}