import * as git from 'isomorphic-git'

/*
 * Browser HTTP transport for the smart git protocol (used by clone/fetch/
 * push/pull; typings require it explicitly).
 */
import webHttp from 'isomorphic-git/http/web'

import {
  createFileSystemAccessGitFs,
} from './gitFs.js'

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

  export type GitSyncStatus = {
    upstream?: string
    ahead: number
    behind: number
  }

  /*
   * Descriptor for a staged change applied by the inline "stage selected
   * lines" flow: the desired index content of a single file.
   */
  export type GitStagedContentInput = {
    filepath: string
    content: Uint8Array
    workingTreeContent: Uint8Array
  }

export type GitCredentials = {
  username?: string
  password?: string
}

export type GitCredentialsProvider = (
  url: string,
) => Promise<GitCredentials>

export type GitRemote = {
  name: string
  url: string
}

export type GitRemoteSyncResult = {
  remote: string
  url: string
  fetchedRef?: string
  pushedRef?: string
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

    /*
     * Desktop VS Code hides untracked files that match .gitignore (or other
     * ignore rules) from the Source Control view.
     */
    const visibleEntries = await filterIgnored(fs, entries)

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
  
      entries: visibleEntries,
    }
  }

  async function filterIgnored(
    fs: ReturnType<typeof getFs>,
    entries: GitTreeEntry[],
  ): Promise<GitTreeEntry[]> {
    const visible: GitTreeEntry[] = []

    for (const entry of entries) {
      if (entry.status === 'untracked') {
        try {
          const ignored = await git.isIgnored({
            fs,
            dir: GIT_DIR,
            gitdir: GIT_METADATA_DIR,
            filepath: entry.path,
          })

          if (ignored) {
            continue
          }
        } catch {
          /* ignore rule evaluation failures do not block the snapshot */
        }
      }

      visible.push(entry)
    }

    return visible
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
    amend?: boolean
  },
): Promise<string> {
  const message = input.message.trim()

  if (message.length === 0 && !input.amend) {
    throw new Error('A commit message is required.')
  }

  const snapshot = await getGitRepositorySnapshot(workspaceHandle)

  if (!snapshot.isRepository) {
    throw new Error('The current workspace is not a Git repository.')
  }

  if (input.amend) {
    await ensureInitialCommit(workspaceHandle)
  } else if (!snapshot.entries.some((entry) => entry.staged)) {
    throw new Error('Stage at least one change before committing.')
  }

  const fs = getFs(workspaceHandle)

  return git.commit({
    fs,
    dir: GIT_DIR,
    gitdir: GIT_METADATA_DIR,
    message,
    author: input.author,
    amend: input.amend,
  })
}


/**
 * Checkout a specific commit (detached HEAD). The working tree must be clean.
 */
export async function checkoutCommit(
  workspaceHandle: FileSystemDirectoryHandle,
  commitId: string,
): Promise<void> {
  await ensureRepository(workspaceHandle)
  await ensureInitialCommit(workspaceHandle)
  await ensureCleanWorkingTree(workspaceHandle)

  const fs = getFs(workspaceHandle)

  await git.checkout({
    fs,
    dir: GIT_DIR,
    gitdir: GIT_METADATA_DIR,
    ref: commitId,
  })
}


/**
 * Read a working-tree file through the isomorphic-git filesystem adapter
 * (same path normalization as statusMatrix, i.e. relative to the workspace
 * root, no leading slash). Returns undefined when the file does not exist.
 */
export async function readWorkdirFile(
  workspaceHandle: FileSystemDirectoryHandle,
  filepath: string,
): Promise<Uint8Array | undefined> {
  const fs = getFs(workspaceHandle)

  try {
    const content = await fs.promises.readFile(`/${filepath}`)

    return typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content
  } catch {
    return undefined
  }
}

/**
 * Write a working-tree file through the same adapter.
 */
export async function writeWorkdirFile(
  workspaceHandle: FileSystemDirectoryHandle,
  filepath: string,
  content: Uint8Array,
): Promise<void> {
  const fs = getFs(workspaceHandle)

  await fs.promises.writeFile(`/${filepath}`, content)
}

/**
 * Stage exact content that may differ from the working tree: transiently
 * write the desired content to the file, git.add() it, then restore the
 * working-tree content. This powers "stage selected lines".
 */
export async function stageExactContent(
  workspaceHandle: FileSystemDirectoryHandle,
  filepath: string,
  stagedContent: Uint8Array,
  workingTreeContent: Uint8Array,
): Promise<void> {
  const fs = getFs(workspaceHandle)

  try {
    await fs.promises.writeFile(`/${filepath}`, stagedContent)
    await git.add({ fs, dir: GIT_DIR, gitdir: GIT_METADATA_DIR, filepath })
  } finally {
    await fs.promises.writeFile(`/${filepath}`, workingTreeContent)
  }
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

  /**
   * Create a local branch from a specific starting point (e.g. a remote
   * tracking ref like "origin/feature-x") and optionally check it out.
   */
  export async function createBranchFrom(
    workspaceHandle: FileSystemDirectoryHandle,
    branchName: string,
    startPoint: string,
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
      object: startPoint,
      checkout: options?.checkout ?? false,
    })
  }

  /**
   * Remote-tracking branch names (without the "origin/" prefix), from the
   * local refs of the last fetch.
   */
  export async function listRemoteBranches(
    workspaceHandle: FileSystemDirectoryHandle,
    remote: string,
  ): Promise<string[]> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    try {
      return await git.listBranches({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        remote,
      })
    } catch {
      return []
    }
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
    options?: {
        filepath?: string
      },
  ): Promise<GitCommitSummary[]> {
    await ensureRepository(workspaceHandle)
  
    const fs = getFs(workspaceHandle)
    const filepath = options?.filepath
  
    try {
      const commits = await git.log({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        ref: 'HEAD',
        depth,
   
        /*
         * isomorphic-git walks the history graph and keeps only commits whose
         * tree contains the given path (like "git log -- <path>"), which is
         * the basis for the per-file timeline view.
         */
        ...(filepath != null && filepath.length > 0 ? { filepath } : {}),
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

  /**
   * Ahead/behind counts for the current branch vs its configured upstream,
   * mirroring the "N↓ M↑" sync status shown in desktop VS Code. Counts are
   * computed locally from the last known remote refs (like VS Code between
   * fetches); they are capped by history depth for performance.
   */
  export async function getSyncStatus(
    workspaceHandle: FileSystemDirectoryHandle,
    depth = 100,
  ): Promise<GitSyncStatus> {
    const fs = getFs(workspaceHandle)

    const branch = await git.currentBranch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      fullname: false,
    })

    if (branch == null || branch.length === 0) {
      return {
        ahead: 0,
        behind: 0,
      }
    }

    const empty: GitSyncStatus = {
      ahead: 0,
      behind: 0,
    }

    /*
     * Read branch.<name>.remote and branch.<name>.merge like the real Git
     * integration does; fall back to pushing/pulling "origin/<branch>" when
     * the branch has no explicit tracking configuration.
     */
    let remoteName: string | undefined
    let mergeRef: string | undefined

    try {
      remoteName = (await git.getConfig({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        path: `branch.${branch}.remote`,
      })) || undefined
    } catch {
      remoteName = undefined
    }

    try {
      mergeRef = (await git.getConfig({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        path: `branch.${branch}.merge`,
      })) || undefined
    } catch {
      mergeRef = undefined
    }

    const upstream =
      remoteName != null && remoteName !== '.'
        ? `refs/remotes/${remoteName}/${branch}`
        : undefined

    if (upstream == null) {
      return empty
    }
    
    let localCommits: Awaited<ReturnType<typeof git.log>>
    let upstreamCommits: Awaited<ReturnType<typeof git.log>>

    try {
      ;[localCommits, upstreamCommits] = await Promise.all([
        git.log({
          fs,
          dir: GIT_DIR,
          gitdir: GIT_METADATA_DIR,
          ref: `refs/heads/${branch}`,
          depth,
        }),
        git.log({
          fs,
          dir: GIT_DIR,
          gitdir: GIT_METADATA_DIR,
          ref: upstream,
          depth,
        }),
      ])
    } catch {
      /*
       * The upstream ref does not exist yet (never pushed), which VS Code
       * displays as "publish branch" rather than ahead/behind numbers.
       */
      return { ...empty, upstream }
    }

    const upstreamOids = new Set(
      upstreamCommits.map((entry) => entry.oid),
    )
    const localOids = new Set(
      localCommits.map((entry) => entry.oid),
    )

    return {
      upstream,
   
      ahead: localCommits.filter(
        (entry) => !upstreamOids.has(entry.oid),
      ).length,
   
      behind: upstreamCommits.filter(
        (entry) => !localOids.has(entry.oid),
      ).length,
    }
  }

  /**
   * Read a single committed blob ("open revision"). Returns undefined when the
   * path did not exist in the given commit.
   */
  export async function readBlobAt(
    workspaceHandle: FileSystemDirectoryHandle,
    commitId: string,
    filepath: string,
  ): Promise<Uint8Array | undefined> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    try {
      const result = await git.readBlob({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        oid: commitId,
        filepath,
      })

      return result.blob
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the HEAD commit SHA. "Unborn HEAD" (initialized repository with
   * no commits) resolves to undefined.
   */
  export async function getHeadCommit(
    workspaceHandle: FileSystemDirectoryHandle,
  ): Promise<string | undefined> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    try {
      return await git.resolveRef({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        ref: 'HEAD',
      })
    } catch {
      return undefined
    }
  }

  /**
   * Discard working-tree changes on the given paths, restoring them to the
   * HEAD state ("git checkout -- <path>"), and delete untracked files. This
   * is what desktop VS Code's per-file "Discard Changes" action does.
   */
  export async function discardPaths(
    workspaceHandle: FileSystemDirectoryHandle,
    paths: string[],
  ): Promise<void> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    for (const path of paths) {
      const matrix = (await git.statusMatrix({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        refresh: true,

        filter: (filepath) => filepath === path,
      })) as Array<[string, number, number, number]>

      const entry = matrix[0]
      const workdir = entry?.[2] ?? 0
      const stage = entry?.[3] ?? 0

      if (workdir === 0 && stage === 0) {
        continue
      }

      if (stage === 0) {
        // Untracked file: discard deletes the file outright.
        await fs.promises.unlink(path)

        continue
      }

      const head = entry?.[1] ?? 0

      /*
       * If the change is staged, it must be unstaged first so the index
       * matches HEAD before restoring the worktree (desktop VS Code resets
       * to HEAD, which includes unstaging).
       */
      if (head !== stage) {
        await git.resetIndex({
          fs,
          dir: GIT_DIR,
          gitdir: GIT_METADATA_DIR,
          filepath: path,
        })
      }

      await git.checkout({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        ref: 'HEAD',
        force: true,
        filepaths: [path],
      })
    }
  }

  export async function listRemotes(
    workspaceHandle: FileSystemDirectoryHandle,
  ): Promise<GitRemote[]> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    const remotes = await git.listRemotes({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
    })

    return remotes.map((entry) => ({
      name: entry.remote,
      url: entry.url,
    }))
  }

  export async function getRemoteUrl(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteName: string,
  ): Promise<string | undefined> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    try {
      return await git.getConfig({
        fs,
        dir: GIT_DIR,
        gitdir: GIT_METADATA_DIR,
        path: `remote.${remoteName}.url`,
      })
    } catch {
      return undefined
    }
  }

  export async function addRemote(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteName: string,
    remoteUrl: string,
  ): Promise<void> {
    await ensureRepository(workspaceHandle)

    const name = remoteName.trim()

    if (name.length === 0) {
      throw new Error('A remote name is required.')
    }

    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(
        'The remote name may only contain letters, digits, ".", "_" and "-".',
      )
    }

    const url = validateRemoteUrl(remoteUrl)

    const fs = getFs(workspaceHandle)

    await git.addRemote({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      remote: name,
      url,
    })
  }

  export async function deleteRemote(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteName: string,
  ): Promise<void> {
    await ensureRepository(workspaceHandle)

    const fs = getFs(workspaceHandle)

    await git.deleteRemote({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      remote: remoteName,
    })
  }

  function validateRemoteUrl(value: string): string {
    const url = value.trim()

    if (url.length === 0) {
      throw new Error('A remote URL is required.')
    }

    let parsed: URL

    try {
      parsed = new URL(url)
    } catch {
      throw new Error(
        'The remote URL must be an absolute HTTPS (or HTTP localhost) URL.',
      )
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(
        'Only HTTPS remote URLs are supported in the browser.',
      )
    }

    return url
  }

  async function createOnAuth(
    credentialsProvider: GitCredentialsProvider,
  ): Promise<(url: string) => Promise<GitCredentials>> {
    return async (url) => {
      try {
        return await credentialsProvider(url)
      } catch {
        /*
         * Returning undefined lets isomorphic-git fall back to anonymous
         * access for public repositories.
         */
        return {}
      }
    }
  }

  export async function cloneRepository(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteUrl: string,
    options?: {
      credentialsProvider?: GitCredentialsProvider
      depth?: number
      ref?: string
    },
  ): Promise<string> {
    const url = validateRemoteUrl(remoteUrl)

    const fs = getFs(workspaceHandle)

    const onAuth =
      options?.credentialsProvider != null
        ? await createOnAuth(options.credentialsProvider)
        : undefined

    await git.clone({
      fs,
      http: webHttp,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      url,
      ref: options?.ref,
      depth: options?.depth,
      singleBranch: true,
      noCheckout: false,
      onAuth,
      
    })

    return url
  }

  export async function fetchRemote(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteName: string,
    options?: {
      credentialsProvider?: GitCredentialsProvider
    },
  ): Promise<GitRemoteSyncResult> {
    await ensureRepository(workspaceHandle)

    const url = await getRemoteUrl(workspaceHandle, remoteName)

    if (url == null) {
      throw new Error(`Remote "${remoteName}" is not configured.`)
    }

    const fs = getFs(workspaceHandle)

    const onAuth =
      options?.credentialsProvider != null
        ? await createOnAuth(options.credentialsProvider)
        : undefined

    await git.fetch({
      http: webHttp,
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      remote: remoteName,
      url,
      onAuth,
      
    })

    return {
      remote: remoteName,
      url,
    }
  }

  export async function pullRemote(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteName: string,
    options?: {
      credentialsProvider?: GitCredentialsProvider
      fastForwardOnly?: boolean
    },
  ): Promise<GitRemoteSyncResult> {
    await ensureRepository(workspaceHandle)
    await ensureInitialCommit(workspaceHandle)

    const fetched = await fetchRemote(workspaceHandle, remoteName, options)

    const fs = getFs(workspaceHandle)
    const branch = await git.currentBranch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      fullname: false,
    })

    if (branch == null) {
      throw new Error('The repository has no current branch to pull into.')
    }

    await git.fastForward({
      http: webHttp,
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      remote: remoteName,
      ref: branch,
      
    })

    return {
      ...fetched,
      fetchedRef: `refs/heads/${branch}`,
    }
  }

  export async function pushRemote(
    workspaceHandle: FileSystemDirectoryHandle,
    remoteName: string,
    options?: {
      credentialsProvider?: GitCredentialsProvider
      force?: boolean
    },
  ): Promise<GitRemoteSyncResult> {
    await ensureRepository(workspaceHandle)
    await ensureInitialCommit(workspaceHandle)

    const url = await getRemoteUrl(workspaceHandle, remoteName)

    if (url == null) {
      throw new Error(`Remote "${remoteName}" is not configured.`)
    }

    const fs = getFs(workspaceHandle)
    const branch = await git.currentBranch({
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      fullname: false,
    })

    if (branch == null) {
      throw new Error('The repository has no current branch to push.')
    }

    const onAuth =
      options?.credentialsProvider != null
        ? await createOnAuth(options.credentialsProvider)
        : undefined

    await git.push({
      http: webHttp,
      fs,
      dir: GIT_DIR,
      gitdir: GIT_METADATA_DIR,
      remote: remoteName,
      url,
      ref: branch,
      remoteRef: branch,
      force: options?.force ?? false,
      onAuth,
      
    })

    return {
      remote: remoteName,
      url,
      pushedRef: `refs/heads/${branch}`,
    }
  }