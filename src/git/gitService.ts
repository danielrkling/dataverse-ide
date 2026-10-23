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

export type GitBranch = {
    name: string
    current: boolean
  }
  
  export type GitCommitSummary = {
    oid: string
    message: string
    authorName: string
    authorEmail: string
    timestamp: number
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

function validateBranchName(branchName: string): string {
    const name = branchName.trim()
  
    if (name.length === 0) {
      throw new Error('A branch name is required.')
    }
  
    if (
      name.startsWith('/') ||
      name.endsWith('/') ||
      name.startsWith('.') ||
      name.endsWith('.') ||
      name.includes('..') ||
      name.includes('//') ||
      name.includes('\\') ||
      name.includes('@{') ||
      /[\s~^:?*\[\]]/.test(name)
    ) {
      throw new Error(
        'The branch name contains unsupported Git reference characters.',
      )
    }
  
    return name
  }
  
  async function ensureRepository(
    workspaceHandle: FileSystemDirectoryHandle,
  ): Promise<void> {
    const snapshot = await getGitRepositorySnapshot(workspaceHandle)
  
    if (!snapshot.isRepository) {
      throw new Error(
        'The current workspace is not initialized as a Git repository.',
      )
    }
  }
  
  async function ensureCleanWorkingTree(
    workspaceHandle: FileSystemDirectoryHandle,
  ): Promise<void> {
    const snapshot = await getGitRepositorySnapshot(workspaceHandle)
  
    if (snapshot.entries.length > 0) {
      throw new Error(
        'Commit, stage, or discard all changes before switching or deleting branches.',
      )
    }
  }
  
  async function ensureInitialCommit(
    workspaceHandle: FileSystemDirectoryHandle,
  ): Promise<void> {
    const fs = getFs(workspaceHandle)
  
    try {
      await git.resolveRef({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        ref: 'HEAD',
      })
    } catch {
      throw new Error(
        'Create an initial commit before creating or switching branches.',
      )
    }
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
  
    /*
     * A freshly initialized repository has an unborn HEAD:
     *
     *   HEAD -> refs/heads/main
     *
     * but refs/heads/main does not exist until the first commit. That is valid
     * Git state, so do not let resolveRef("HEAD") fail the entire snapshot.
     */
    const [branch, matrix, head] = await Promise.all([
      git.currentBranch({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        fullname: false,
      }),
  
      git.statusMatrix({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        refresh: true,
  
        filter: (filepath) => !filepath.startsWith('.git/'),
      }),
  
      git.resolveRef({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        ref: 'HEAD',
      }).catch(() => undefined),
    ])
  
    const entries = matrix
      .map(([path, headStatus, workdirStatus, stageStatus]) => {
        const headNumber = headStatus as number
        const workdirNumber = workdirStatus as number
        const stageNumber = stageStatus as number
  
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
  
      /*
       * currentBranch() should return "main" after initializeRepository()
       * repoints HEAD, even before the first commit.
       */
      branch: branch ?? 'main',
  
      /*
       * Undefined is expected until an initial commit exists.
       */
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


export async function initializeRepository(
    workspaceHandle: FileSystemDirectoryHandle,
    initialBranch = 'main',
  ): Promise<void> {
    const fs = getFs(workspaceHandle)
  
    const branchName = validateBranchName(initialBranch)
  
    const snapshot = await getGitRepositorySnapshot(workspaceHandle)
  
    if (snapshot.isRepository) {
      throw new Error(
        'The current workspace is already a Git repository.',
      )
    }
  
    await git.init({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
    })
  
    /*
     * git.init() creates HEAD. Repoint it to the desired unborn initial branch
     * so the first commit creates refs/heads/main rather than a legacy default.
     */
    await git.writeRef({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      ref: 'HEAD',
      value: `refs/heads/${branchName}`,
      symbolic: true,
      force: true,
    })
  }
  
  export async function listLocalBranches(
    workspaceHandle: FileSystemDirectoryHandle,
  ): Promise<GitBranch[]> {
    await ensureRepository(workspaceHandle)
  
    const fs = getFs(workspaceHandle)
  
    const [branches, currentBranch] = await Promise.all([
      git.listBranches({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
      }),
  
      git.currentBranch({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        fullname: false,
      }),
    ])
  
    return branches
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({
        name,
        current: name === currentBranch,
      }))
  }
  
  export async function createBranch(
    workspaceHandle: FileSystemDirectoryHandle,
    branchName: string,
    options?: {
      checkout?: boolean
    },
  ): Promise<void> {
    await ensureRepository(workspaceHandle)
    await ensureInitialCommit(workspaceHandle)
  
    const fs = getFs(workspaceHandle)
    const ref = validateBranchName(branchName)
  
    await git.branch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      ref,
      checkout: options?.checkout ?? false,
    })
  }
  
  export async function switchBranch(
    workspaceHandle: FileSystemDirectoryHandle,
    branchName: string,
  ): Promise<void> {
    await ensureRepository(workspaceHandle)
    await ensureInitialCommit(workspaceHandle)
    await ensureCleanWorkingTree(workspaceHandle)
  
    const fs = getFs(workspaceHandle)
    const ref = validateBranchName(branchName)
  
    await git.checkout({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      ref,
    })
  }
  
  export async function deleteLocalBranch(
    workspaceHandle: FileSystemDirectoryHandle,
    branchName: string,
  ): Promise<void> {
    await ensureRepository(workspaceHandle)
    await ensureCleanWorkingTree(workspaceHandle)
  
    const fs = getFs(workspaceHandle)
    const ref = validateBranchName(branchName)
  
    const currentBranch = await git.currentBranch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      fullname: false,
    })
  
    if (ref === currentBranch) {
      throw new Error(
        'Switch to another branch before deleting the current branch.',
      )
    }
  
    await git.deleteBranch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      ref,
    })
  }
  
  export async function getRecentCommits(
    workspaceHandle: FileSystemDirectoryHandle,
    depth = 20,
  ): Promise<GitCommitSummary[]> {
    await ensureRepository(workspaceHandle)
  
    const fs = getFs(workspaceHandle)
  
    try {
      const commits = await git.log({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        ref: 'HEAD',
        depth,
      })
  
      return commits.map((entry) => ({
        oid: entry.oid,
        message: entry.commit.message.trim(),
        authorName: entry.commit.author.name,
        authorEmail: entry.commit.author.email,
        timestamp: entry.commit.author.timestamp,
      }))
    } catch {
      /*
       * An initialized repository with no initial commit has no log yet.
       */
      return []
    }
  }