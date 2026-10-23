import * as git from 'isomorphic-git'

import {
  createFileSystemAccessGitFs,
} from './fileSystemAccessGitFs.js'

const GIT_DIR = '/'
const GIT_METADATA_DIR = '/.git'

export type GitFileStatus =
  | 'clean'
  | 'untracked'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'modified-and-staged'
  | 'deleted-and-staged'

export type GitTreeEntry = {
  path: string
  status: GitFileStatus

  /*
   * Raw isomorphic-git statusMatrix values:
   *
   * HEAD     = prior committed content
   * WORKDIR  = current working-tree content
   * STAGE    = next committed content
   */
  head: number
  workdir: number
  stage: number

  /*
   * These are the authoritative group assignments:
   *
   * Unstaged change: WORKDIR differs from STAGE.
   * Staged change:   HEAD differs from STAGE.
   */
  changed: boolean
  staged: boolean
}

export type GitRepositorySnapshot = {
  isRepository: boolean
  branch?: string
  head?: string
  entries: GitTreeEntry[]
}

function getStatus(
  head: number,
  workdir: number,
  stage: number,
): GitFileStatus {
  if (head === workdir && workdir === stage) {
    return 'clean'
  }

  if (head === 0 && workdir !== 0 && stage === 0) {
    return 'untracked'
  }

  if (workdir === 0 && stage === 0) {
    return 'deleted-and-staged'
  }

  if (workdir === 0) {
    return 'deleted'
  }

  if (head === 0 && stage !== 0) {
    return 'added'
  }

  if (head !== stage && workdir !== stage) {
    return 'modified-and-staged'
  }

  return 'modified'
}

function getFs(workspaceHandle: FileSystemDirectoryHandle) {
  return createFileSystemAccessGitFs(workspaceHandle)
}

export async function getGitRepositorySnapshot(
  workspaceHandle: FileSystemDirectoryHandle,
): Promise<GitRepositorySnapshot> {
  const fs = getFs(workspaceHandle)

  try {
    await fs.promises.readFile('/.git/HEAD', 'utf8')
  } catch {
    return {
      isRepository: false,
      entries: [],
    }
  }

  const [branch, head, matrix] = await Promise.all([
    git.currentBranch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      fullname: false,
    }),

    git.resolveRef({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      ref: 'HEAD',
    }),

    git.statusMatrix({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,

      /*
       * false was necessary for the prior read-only adapter. It can now be
       * enabled because index metadata can be written to .git.
       */
      refresh: true,

      filter: (filepath) => !filepath.startsWith('.git/'),
    }),
  ])

  const entries = matrix
    .map(([path, head, workdir, stage]) => {
      const headNumber = head as number
      const workdirNumber = workdir as number
      const stageNumber = stage as number

      return {
        path: path as string,
        status: getStatus(
          headNumber,
          workdirNumber,
          stageNumber,
        ),
        head: headNumber,
        workdir: workdirNumber,
        stage: stageNumber,
        changed: workdirNumber !== stageNumber,
        staged: headNumber !== stageNumber,
      }
    })
    .filter((entry) => entry.changed || entry.staged)

  return {
    isRepository: true,
    branch: branch ?? 'DETACHED',
    head,
    entries,
  }
}

export async function stagePaths(
  workspaceHandle: FileSystemDirectoryHandle,
  filepaths: string[],
): Promise<void> {
  const fs = getFs(workspaceHandle)
  const snapshot = await getGitRepositorySnapshot(workspaceHandle)

  for (const filepath of filepaths) {
    const entry = snapshot.entries.find(
      (candidate) => candidate.path === filepath,
    )

    if (entry == null || !entry.changed) {
      continue
    }

    /*
     * A missing working-tree file is staged as a removal. git.remove() updates
     * the index only; it does not delete a file from the working directory.
     */
    if (entry.workdir === 0) {
      await git.remove({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        filepath,
      })
    } else {
      await git.add({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        filepath,
      })
    }
  }
}

export async function stageAll(
  workspaceHandle: FileSystemDirectoryHandle,
): Promise<void> {
  const snapshot = await getGitRepositorySnapshot(workspaceHandle)

  await stagePaths(
    workspaceHandle,
    snapshot.entries
      .filter((entry) => entry.changed)
      .map((entry) => entry.path),
  )
}

export async function unstagePaths(
  workspaceHandle: FileSystemDirectoryHandle,
  filepaths: string[],
): Promise<void> {
  const fs = getFs(workspaceHandle)
  const snapshot = await getGitRepositorySnapshot(workspaceHandle)

  for (const filepath of filepaths) {
    const entry = snapshot.entries.find(
      (candidate) => candidate.path === filepath,
    )

    if (entry == null || !entry.staged) {
      continue
    }

    await git.resetIndex({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      filepath,
      ref: 'HEAD',
    })
  }
}

export async function unstageAll(
  workspaceHandle: FileSystemDirectoryHandle,
): Promise<void> {
  const snapshot = await getGitRepositorySnapshot(workspaceHandle)

  await unstagePaths(
    workspaceHandle,
    snapshot.entries
      .filter((entry) => entry.staged)
      .map((entry) => entry.path),
  )
}

export async function createCommit(
  workspaceHandle: FileSystemDirectoryHandle,
  input: {
    message: string
    author: {
      name: string
      email: string
    }
  },
): Promise<string> {
  const message = input.message.trim()

  if (message.length === 0) {
    throw new Error('A commit message is required.')
  }

  const snapshot = await getGitRepositorySnapshot(workspaceHandle)

  if (!snapshot.isRepository) {
    throw new Error('The current workspace is not a Git repository.')
  }

  if (!snapshot.entries.some((entry) => entry.staged)) {
    throw new Error('Stage at least one change before committing.')
  }

  const fs = getFs(workspaceHandle)

  return git.commit({
    fs,
    dir: GIT_DIR,
    gitdir: GIT_METADATA_DIR,
    message,
    author: input.author,
  })
}