# Git

A browser implementation of Git built on isomorphic-git. It talks to HTTPS remotes
directly from the workspace, so you can initialize a repository, stage and commit changes,
work with branches, review history, and push or pull without a desktop Git installation.

Use it for source control on a local folder workspace. The extension writes `.git` through
the same File System Access handle as the editor.

## Before you start

- **Open a local folder.** The extension needs the directory handle; browser (OPFS)
  workspaces cannot use it and activation fails.
- **Have an HTTPS remote.** Clone, fetch, pull and push use HTTPS. SSH remotes are not
  supported.
- **Know your token.** For GitHub use a personal access token with the username
  `x-access-token` (or leave the username blank). For GitLab use `oauth2` and a PAT with
  `read_repository`/`write_repository`. Credentials are requested the first time a remote
  operation needs them and cached per host in secret storage — never written to
  `.git/config`.

## Quick start

### Start a new repository

1. Open the folder you want to version.
2. Run `Git: Initialize Repository`.
3. Stage files with `Git: Stage All Changes` (or stage selected lines while reviewing a
   diff), then `Git: Commit Staged Changes`.
4. Run `Git: Add Remote` and enter `origin` plus the HTTPS URL.
5. Run `Git: Push`.

### Work with an existing repository

1. Run `Git: Clone Repository` and paste the HTTPS URL.
2. Confirm **Clone Here**. The clone goes into the current workspace folder (you are warned
   when it is not empty); the default depth is 50 commits.
3. Edit, stage and commit as usual.

The Source Control view shows the working tree; the same operations are available from the
command palette.

## Commands

| Command                                                     | What it does                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `Git: Initialize Repository`                                | Creates `.git` in the workspace.                               |
| `Git: Clone Repository`                                     | Shallow-clones an HTTPS URL into the current workspace folder. |
| `Git: Refresh Status`                                       | Re-reads the working tree and decorations.                     |
| `Git: Stage Changes` / `Stage All Changes`                  | Stages selected files or everything.                           |
| `Git: Unstage Changes` / `Unstage All Changes`              | Moves changes back to the working tree.                        |
| `Git: Stage Selected Lines` / `Discard Selected Lines`      | Line-level staging and discarding from a diff.                 |
| `Git: Commit Staged Changes`                                | Commits with the configured or prompted author.                |
| `Git: Commit (Amend Last Commit)`                           | Rewrites the previous commit.                                  |
| `Git: Discard Changes` / `Discard All Changes`              | Throws away working-tree edits.                                |
| `Git: Open Changes`                                         | Opens the diff for a file.                                     |
| `Git: Create Branch` / `Switch Branch` / `Delete Branch`    | Branch management.                                             |
| `Git: Show Commit History` / `Show File History (Timeline)` | Repository and per-file history.                               |
| `Git: Sync`                                                 | Fast-forward pull, then push, on the selected remote.          |
| `Git: Add Remote` / `Remove Remote`                         | Remote management.                                             |
| `Git: Fetch` / `Pull` / `Push`                              | Individual remote operations.                                  |
| `Git: Forget Stored Remote Credentials`                     | Clears the cached token for a host.                            |
| `Git: Add to .gitignore`                                    | Appends a path to `.gitignore`.                                |

## Settings

| Setting                             | Default | Notes                                                                                          |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `dataverseIde.git.authorName`       | `""`    | Commit author name. Set it with the email to skip the author prompt.                           |
| `dataverseIde.git.authorEmail`      | `""`    | Commit author email.                                                                           |
| `dataverseIde.git.autoFetchMinutes` | `0`     | Fetch from the configured remote every N minutes while the workspace is open. `0` disables it. |

`Dataverse: Load User Identity` fills the author settings with the signed-in Dataverse user,
so commits and web resource metadata agree.

## How sync behaves

`Git: Sync` first tries a fast-forward pull and then pushes. If the branch has diverged, the
pull is skipped (the reason is logged) and the push may be rejected by the remote. In that
case, pull/rebase explicitly, resolve the conflict, and commit before syncing again.

## Recipes

### Commit as the Dataverse user

1. Run `Dataverse: Load User Identity` (requires the Dataverse extension and a local folder).
2. Commit. The author name and email come from `dataverseIde.git.authorName/authorEmail`;
   no prompt appears.

### Switch between GitHub and GitLab remotes

Credentials are cached per host, so a GitHub PAT and a GitLab PAT can coexist. Use
`Git: Add Remote` for each remote and pick one during a push/pull/sync. If a token expires,
run `Git: Forget Stored Remote Credentials` and retry.

### Review a file before committing

Open the file's diff (`Git: Open Changes`), select lines, and use
`Git: Stage Selected Lines`. The explorer decorations show staged, modified, deleted and
untracked files.

## Troubleshooting

| Symptom                                                              | Cause and fix                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `The git extension requires a local workspace directory handle.`     | Browser/OPFS workspace. Open a local folder.                                                                                                                 |
| `Git remote credentials are not configured for this workspace type.` | Sync/push/pull needs the local folder handle and credential store.                                                                                           |
| Authentication failed                                                | The token is expired or lacks repository scope. Forget the credentials and retry with a new PAT. GitHub: `x-access-token` as the username; GitLab: `oauth2`. |
| Push rejected (non-fast-forward)                                     | The branch diverged. Pull/rebase, resolve conflicts, then push.                                                                                              |
| `Add a remote before pulling/pushing.`                               | Run `Git: Add Remote` first.                                                                                                                                 |
| Clone ends up mixed with existing files                              | Clone targets the current workspace folder. Use an empty folder for a clean clone.                                                                           |

## Limits

- HTTPS only — no SSH remotes, no credential helpers, no Git hooks, and no desktop Git
  binary.
- Clones use depth 50 by default, so older history is not available in the IDE.
- Large repositories are read and written through the File System Access API, so operations
  are slower than a native Git client.
