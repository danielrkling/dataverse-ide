# GitLab

GitLab integration over the REST API. Connect with a personal access token, pick a project,
and browse or create merge requests, issues and pipelines without leaving the IDE. Cloning
uses the same browser Git implementation as the Git extension.

This extension is separate from Git: it handles GitLab-specific API features, while
commit/push/pull stay in the Source Control view.

## Before you start

- **Create a personal access token** with the `read_api` and `write_repository` scopes.
  Creating issues or merge requests usually also needs the `api` scope. The token is sent
  in the `PRIVATE-TOKEN` header and stored in secret storage — not in settings.
- **Know the instance URL.** The default is `https://gitlab.com`; set `baseUrl` for a
  self-hosted instance, for example `https://gitlab.example.com`.
- **Have a project path.** `group/project` is used as-is when set. Leave it empty to derive
  it from the workspace's `origin` remote (only when the remote host matches `baseUrl`).
- **Open a local folder if you want to clone.** Browsing merge requests and issues works
  without a folder; cloning needs the File System Access handle.

## Quick start

1. Run `GitLab: Connect (Personal Access Token)`, enter the instance URL if it is not
   gitlab.com, and paste the token. The token is verified against the instance; if
   verification fails it is still saved so you can correct the URL and reconnect.
2. Run `GitLab: Select Project` and pick the project, or set
   `dataverseIde.gitlab.project` to `group/project` in settings.
3. Open the **GitLab** panel in the activity bar, or run:
   - `GitLab: Show Merge Requests`
   - `GitLab: Show Issues`
   - `GitLab: Show Pipelines`
4. Use the picked item to open it in the browser, or create new work with
   `GitLab: New Issue` / `GitLab: New Merge Request`.

To clone, run `GitLab: Clone Repository`. Accepts a project path, an HTTPS URL, or the
common `git@host:group/project.git` form (converted to HTTPS). The clone goes into the
current workspace folder and warns when the folder is not empty.

## Commands

| Command                                   | What it does                                                  |
| ----------------------------------------- | ------------------------------------------------------------- |
| `GitLab: Connect (Personal Access Token)` | Saves and verifies a PAT for the configured instance.         |
| `GitLab: Disconnect`                      | Removes the stored token.                                     |
| `GitLab: Select Project`                  | Picks from accessible projects and remembers the choice.      |
| `GitLab: Clone Repository`                | Clones a project into the current workspace folder.           |
| `GitLab: Open Project in Browser`         | Opens the project's GitLab page.                              |
| `GitLab: Show Merge Requests`             | Lists open merge requests.                                    |
| `GitLab: Show Issues`                     | Lists open issues.                                            |
| `GitLab: Show Pipelines`                  | Lists recent pipelines.                                       |
| `GitLab: New Issue`                       | Creates an issue through the API and opens it.                |
| `GitLab: New Merge Request`               | Creates a merge request from the current branch and opens it. |
| `GitLab: Open Settings`                   | Opens the GitLab settings in the IDE.                         |

## Settings

| Setting                             | Default              | Notes                                                                  |
| ----------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `dataverseIde.gitlab.baseUrl`       | `https://gitlab.com` | Instance base URL. Missing scheme is treated as `https://`.            |
| `dataverseIde.gitlab.project`       | `""`                 | `group/project`. Empty derives it from `origin`.                       |
| `dataverseIde.gitlab.defaultBranch` | `""`                 | Used for clone and new merge requests; empty uses the project default. |
| `dataverseIde.gitlab.cloneDepth`    | `50`                 | Clone history depth. `0` clones the full history.                      |

The settings are also editable from the **GitLab** sidebar panel, which writes workspace
settings.

## Recipes

### Browse merge requests for the current project

1. Connect once.
2. Leave `project` empty and make sure the repository's `origin` points at the same GitLab
   instance (or set `project` explicitly).
3. Run `GitLab: Show Merge Requests`; picking an item opens it in a browser tab.

### Create a merge request from the current branch

1. Commit and push the branch with the Git extension.
2. Run `GitLab: New Merge Request`.
3. Enter the target branch and title. The request is created through the API and its web
   page opens for review.

### Work with a self-hosted instance

Set `dataverseIde.gitlab.baseUrl` before connecting. Tokens are scoped to the instance; if
you switch instances, disconnect and connect again with a token from the new one.

## Troubleshooting

| Symptom                                               | Cause and fix                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GitLab: connect with a personal access token first.` | The feature needs a token. Run Connect.                                                                               |
| 401 from the API                                      | Token expired, revoked, or lacks `read_api`. Create a new token and reconnect.                                        |
| `could not verify the token against <url>`            | The instance URL is wrong or the token is for a different instance. The token was saved; fix `baseUrl` and reconnect. |
| Project not detected                                  | `origin` is missing or points at a different host. Set `dataverseIde.gitlab.project` explicitly.                      |
| Clone requires a local workspace folder               | Browser/OPFS workspaces have no directory handle. Open a local folder.                                                |
| Clone warning about a non-empty workspace             | Cloning writes into the current folder. Use an empty folder for a clean clone.                                        |

## Limits

- REST API only: Git operations still go through the Git extension (Source Control view).
- Clone is HTTPS; SSH URLs are converted to HTTPS, so an SSH key alone is not enough —
  a token is needed for private projects.
- Merge request creation prompts for source and target branches (the current branch and
  `defaultBranch`/`main` are prefilled). There is no full diff editor or review UI.
