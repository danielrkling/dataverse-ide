import type * as vscodeType from "vscode";

import { contributeCommandManifest } from "../api.js";

import { createPanelIcon, PANEL_GLYPHS, registerExtensionPanel } from "../panels.js";

import { cloneRepository } from "../git/service.js";

import {
  GITLAB_CONFIGURATION_PROPERTIES,
  GITLAB_SETTING_DEFAULTS,
  normalizeBaseUrl,
  readGitLabSettings,
  updateGitLabSetting,
} from "./config.js";

import type {
  ExtensionContext,
  IdeExtension,
  IdeExtensionHttp,
  IdeExtensionSecretStore,
} from "../api.js";

import {
  GitLabClient,
  projectPathFromRemoteUrl,
  type GitLabIssue,
  type GitLabMergeRequest,
  type GitLabPipeline,
  type GitLabProject,
} from "./client.js";

/*
 * GitLab extension (REST API v4, PAT auth - fully separate from the git
 * extension's git-transport credentials).
 *
 * Configuration (workspace settings):
 *   dataverseIde.gitlab.baseUrl        e.g. https://gitlab.com or self-hosted
 *   dataverseIde.gitlab.project        "group/project" (defaulted from origin)
 *   dataverseIde.gitlab.defaultBranch  branch used for clone / merge requests
 *   dataverseIde.gitlab.cloneDepth     clone history depth (0 = full)
 *
 * Token: stored in secret storage via "GitLab: Connect".
 */

const COMMAND_CONNECT = "dataverseIde.gitlab.connect";
const COMMAND_DISCONNECT = "dataverseIde.gitlab.disconnect";
const COMMAND_SELECT_PROJECT = "dataverseIde.gitlab.selectProject";
const COMMAND_CLONE = "dataverseIde.gitlab.cloneRepository";
const COMMAND_OPEN_PROJECT = "dataverseIde.gitlab.openProject";
const COMMAND_OPEN_SETTINGS = "dataverseIde.gitlab.openSettings";
const COMMAND_SHOW_MRS = "dataverseIde.gitlab.showMergeRequests";
const COMMAND_SHOW_ISSUES = "dataverseIde.gitlab.showIssues";
const COMMAND_SHOW_PIPELINES = "dataverseIde.gitlab.showPipelines";
const COMMAND_CREATE_ISSUE = "dataverseIde.gitlab.createIssue";
const COMMAND_CREATE_MR = "dataverseIde.gitlab.createMergeRequest";

async function readGitRemoteUrl(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(rootUri, ".git", "config"),
    );

    const text = new TextDecoder().decode(bytes);

    const match = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s.exec(text);

    return match?.[1];
  } catch {
    return undefined;
  }
}

type ProjectResolution = {
  project: string;
  origin?: { host: string; path: string };
};

async function resolveProject(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<ProjectResolution | undefined> {
  const settings = readGitLabSettings(vscode, rootUri);

  const remoteUrl = await readGitRemoteUrl(vscode, rootUri);
  const origin = remoteUrl ? projectPathFromRemoteUrl(remoteUrl) : undefined;

  if (settings.project.length > 0) {
    return { project: settings.project, origin: origin ?? undefined };
  }

  if (origin != null) {
    let baseHost: string | undefined;

    try {
      baseHost = new URL(settings.baseUrl).host;
    } catch {
      baseHost = undefined;
    }

    if (baseHost == null || origin.host === baseHost) {
      return { project: origin.path, origin };
    }
  }

  return undefined;
}

/*
 * Turn user input into an HTTPS clone URL. Accepts a project path, an HTTPS
 * URL, or the common scp-like SSH form (`git@host:group/project.git`), which
 * browsers cannot use directly.
 */
function httpsCloneUrlForHostPath(path: string, host: string, baseUrl: string): string {
  try {
    const base = new URL(normalizeBaseUrl(baseUrl));

    if (base.host === host) {
      const prefix = base.pathname.replace(/^\/+|\/+$/g, "");

      return `${base.protocol}//${base.host}/${prefix.length > 0 ? `${prefix}/` : ""}${path}.git`;
    }
  } catch {
    // Fall back to the scp host below.
  }

  return `https://${host}/${path}.git`;
}

function cloneTargetForInput(
  value: string,
  baseUrl: string,
): { url: string; project?: string } | undefined {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = projectPathFromRemoteUrl(trimmed);

    return { url: trimmed, project: parsed?.path };
  }

  if (/^ssh:\/\//i.test(trimmed)) {
    const parsed = projectPathFromRemoteUrl(trimmed);

    if (parsed == null) {
      return undefined;
    }

    return {
      url: httpsCloneUrlForHostPath(parsed.path, parsed.host, baseUrl),
      project: parsed.path,
    };
  }

  if (trimmed.includes("://")) {
    return undefined;
  }

  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);

  if (scp != null) {
    const path = scp[2].replace(/^\/+/, "").replace(/\.git$/, "");

    if (path.length === 0) {
      return undefined;
    }

    return {
      url: httpsCloneUrlForHostPath(path, scp[1], baseUrl),
      project: path,
    };
  }

  const path = trimmed
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  if (path.length === 0) {
    return undefined;
  }

  return {
    url: `${normalizeBaseUrl(baseUrl)}/${path}.git`,
    project: path,
  };
}

function projectWebUrl(baseUrl: string, project: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${project.replace(/^\/+/, "")}`;
}

function formatTimestamp(value?: string): string {
  if (value == null) {
    return "";
  }

  const timestamp = new Date(value).getTime();

  if (Number.isNaN(timestamp)) {
    return "";
  }

  return new Date(timestamp).toLocaleString();
}

export default {
  id: "gitlab",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel, secrets, http } = context;

    await contributeCommandManifest({
      id: "gitlab",
      displayName: "Dataverse IDE GitLab",
      description: "GitLab REST API integration (PAT-based).",
      commands: [
        {
          command: COMMAND_CONNECT,
          title: "GitLab: Connect (Personal Access Token)",
        },
        {
          command: COMMAND_DISCONNECT,
          title: "GitLab: Disconnect",
        },
        {
          command: COMMAND_SELECT_PROJECT,
          title: "GitLab: Select Project",
        },
        {
          command: COMMAND_CLONE,
          title: "GitLab: Clone Repository",
        },
        {
          command: COMMAND_OPEN_PROJECT,
          title: "GitLab: Open Project in Browser",
        },
        {
          command: COMMAND_OPEN_SETTINGS,
          title: "GitLab: Open Settings",
        },
        {
          command: COMMAND_SHOW_MRS,
          title: "GitLab: Show Merge Requests",
        },
        {
          command: COMMAND_SHOW_ISSUES,
          title: "GitLab: Show Issues",
        },
        {
          command: COMMAND_SHOW_PIPELINES,
          title: "GitLab: Show Pipelines",
        },
        {
          command: COMMAND_CREATE_ISSUE,
          title: "GitLab: New Issue",
        },
        {
          command: COMMAND_CREATE_MR,
          title: "GitLab: New Merge Request",
        },
      ],
      configuration: {
        title: "GitLab",
        properties: { ...GITLAB_CONFIGURATION_PROPERTIES },
      },
    });

    /*
     * Sidebar panel: "GitLab" — connection settings (the token itself stays
     * in secret storage via the Connect action) plus quick actions.
     */
    const gitlabPanel = registerExtensionPanel(vscode, {
      extensionId: "gitlab",
      title: "GitLab",
      icon: createPanelIcon(PANEL_GLYPHS.gitlab),
      description:
        "GitLab integration. Connect with a personal access token, then clone projects and browse merge requests, issues, and pipelines.",
      workspaceRootUri: context.workspaceRootUri,
      settings: [
        {
          type: "string",
          key: "baseUrl",
          label: "Instance URL",
          default: GITLAB_SETTING_DEFAULTS.baseUrl,
          description: "Base URL of the GitLab instance",
          placeholder: GITLAB_SETTING_DEFAULTS.baseUrl,
        },
        {
          type: "string",
          key: "project",
          label: "Project path",
          default: GITLAB_SETTING_DEFAULTS.project,
          description: "group/project — leave empty to derive it from the origin remote",
          placeholder: "my-group/my-project",
        },
        {
          type: "string",
          key: "defaultBranch",
          label: "Default branch",
          default: GITLAB_SETTING_DEFAULTS.defaultBranch,
          description: "Used for cloning and new merge requests; empty uses the project default",
          placeholder: "main",
        },
        {
          type: "number",
          key: "cloneDepth",
          label: "Clone depth",
          default: GITLAB_SETTING_DEFAULTS.cloneDepth,
          min: 0,
          max: 500,
          step: 10,
          integer: true,
          description: "Commits to fetch when cloning; 0 clones the full history",
        },
      ],
      actions: [
        {
          label: "Connect (Personal Access Token)",
          command: COMMAND_CONNECT,
          primary: true,
          tooltip: "Store the GitLab PAT in secret storage",
        },
        {
          label: "Clone Repository",
          command: COMMAND_CLONE,
          tooltip: "Clone a GitLab project into the current workspace",
        },
        {
          label: "Select Project",
          command: COMMAND_SELECT_PROJECT,
          tooltip: "Choose a project from your GitLab instance",
        },
        {
          label: "Open Project",
          command: COMMAND_OPEN_PROJECT,
        },
        {
          label: "Merge Requests",
          command: COMMAND_SHOW_MRS,
        },
        {
          label: "Issues",
          command: COMMAND_SHOW_ISSUES,
        },
        {
          label: "Pipelines",
          command: COMMAND_SHOW_PIPELINES,
        },
        {
          label: "New Issue",
          command: COMMAND_CREATE_ISSUE,
        },
        {
          label: "New Merge Request",
          command: COMMAND_CREATE_MR,
        },
        {
          label: "Disconnect",
          command: COMMAND_DISCONNECT,
        },
        {
          label: "Open Settings",
          command: COMMAND_OPEN_SETTINGS,
          tooltip: "Open the GitLab settings in the Settings editor",
        },
      ],
    });

    async function ensureToken(): Promise<string | undefined> {
      let token = await secrets.get("token");

      if (token != null && token.length > 0) {
        return token;
      }

      await vscode.window.showInformationMessage(
        "GitLab: connect with a personal access token first.",
      );

      token = await promptForToken();

      if (token == null || token.length === 0) {
        return undefined;
      }

      await secrets.set("token", token);

      return token;
    }

    async function promptForToken(): Promise<string | undefined> {
      const token = await vscode.window.showInputBox({
        title: "GitLab: Connect",
        prompt: "Paste a GitLab personal access token (scopes: read_api, write_repository).",
        password: true,
        ignoreFocusOut: true,
      });

      if (token == null || token.trim().length === 0) {
        return undefined;
      }

      await secrets.set("token", token.trim());

      const baseUrl = readGitLabSettings(vscode, context.workspaceRootUri).baseUrl;

      try {
        const client = new GitLabClient({
          baseUrl,
          token: token.trim(),
          http,
        });

        const user = await client.getCurrentUser();

        await vscode.window.showInformationMessage(
          `GitLab: connected as ${user.username} (${baseUrl}).`,
        );
      } catch (error) {
        outputChannel.appendLine(
          `[gitlab] token validation failed: ${error instanceof Error ? error.message : String(error)}`,
        );

        await vscode.window.showWarningMessage(
          `GitLab: could not verify the token against ${baseUrl}. The token was saved; check the instance URL and token scopes.`,
        );
      }

      return token.trim();
    }

    const connectCommand = vscode.commands.registerCommand(COMMAND_CONNECT, async () => {
      const token = await promptForToken();

      if (token == null) {
        outputChannel.show(true);
        outputChannel.appendLine("[gitlab] connect cancelled.");
      }
    });

    /*
     * Shared "ensure ready" helper: validates token + project resolution and
     * reports actionable error messages.
     */
    async function ensureClient(): Promise<
      | {
          client: GitLabClient;
          project: ProjectResolution;
        }
      | undefined
    > {
      const token = await ensureToken();

      if (token == null) {
        return undefined;
      }

      const project = await resolveProject(vscode, context.workspaceRootUri);

      if (project == null) {
        await vscode.window.showErrorMessage(
          'GitLab: cannot determine the project. Set "dataverseIde.gitlab.project" or add a remote (origin) first.',
        );

        return undefined;
      }

      const client = new GitLabClient({
        baseUrl: readGitLabSettings(vscode, context.workspaceRootUri).baseUrl,
        token,
        http,
      });

      return { client, project };
    }

    async function pickProject(
      client: GitLabClient,
      title: string,
    ): Promise<GitLabProject | undefined> {
      const projects = await client.listProjects({ membership: true });

      if (projects.length === 0) {
        await vscode.window.showInformationMessage(
          "GitLab: no projects are available for this account.",
        );

        return undefined;
      }

      const selected = await vscode.window.showQuickPick(
        projects.map((project) => ({
          label: project.path_with_namespace,
          description: project.visibility ?? "",
          detail: project.description ?? "",
          project,
        })),
        {
          title,
          placeHolder: "Select a GitLab project.",
          ignoreFocusOut: true,
        },
      );

      return selected?.project;
    }

    const disconnectCommand = vscode.commands.registerCommand(COMMAND_DISCONNECT, async () => {
      const token = await secrets.get("token");

      if (token == null) {
        await vscode.window.showInformationMessage("GitLab: not connected.");
        return;
      }

      await secrets.remove("token");

      await vscode.window.showInformationMessage("GitLab: personal access token removed.");
    });

    const selectProjectCommand = vscode.commands.registerCommand(
      COMMAND_SELECT_PROJECT,
      async () => {
        const token = await ensureToken();

        if (token == null) {
          return;
        }

        const settings = readGitLabSettings(vscode, context.workspaceRootUri);
        const client = new GitLabClient({
          baseUrl: settings.baseUrl,
          token,
          http,
        });

        try {
          const project = await pickProject(client, "GitLab: Select Project");

          if (project == null) {
            return;
          }

          await updateGitLabSetting(
            vscode,
            context.workspaceRootUri,
            "project",
            project.path_with_namespace,
          );

          await vscode.window.showInformationMessage(
            `GitLab: using project ${project.path_with_namespace}.`,
          );
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          );
          outputChannel.show(true);

          await vscode.window.showErrorMessage(
            "GitLab: failed to load projects (see GitLab output).",
          );
        }
      },
    );

    const cloneCommand = vscode.commands.registerCommand(COMMAND_CLONE, async () => {
      const settings = readGitLabSettings(vscode, context.workspaceRootUri);
      const resolved = await resolveProject(vscode, context.workspaceRootUri);

      const input = await vscode.window.showInputBox({
        title: "GitLab: Clone Repository",
        prompt: "Project path (group/project) or HTTPS clone URL.",
        value: resolved?.project ?? settings.project,
        placeHolder: "my-group/my-project",
        ignoreFocusOut: true,
      });

      if (input == null || input.trim().length === 0) {
        return;
      }

      const target = cloneTargetForInput(input, settings.baseUrl);

      if (target == null) {
        await vscode.window.showErrorMessage(
          "GitLab: enter a valid project path or GitLab HTTPS/SSH URL.",
        );

        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Clone "${target.url}" into the current workspace folder? Opening a non-empty workspace will mix the clone with existing files.`,
        { modal: true },
        "Clone Here",
      );

      if (confirmation !== "Clone Here") {
        return;
      }

      const workspaceHandle = context.workspaceDirectoryHandle;

      if (workspaceHandle == null) {
        await vscode.window.showErrorMessage("GitLab: cloning requires a local workspace folder.");

        return;
      }

      let token = await secrets.get("token");

      if (token == null) {
        const choice = await vscode.window.showInformationMessage(
          "GitLab: a personal access token is required for private repositories. Connect now?",
          "Connect",
          "Clone Anyway",
        );

        if (choice === "Connect") {
          token = await promptForToken();

          if (token == null) {
            return;
          }
        } else if (choice !== "Clone Anyway") {
          return;
        }
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Cloning ${target.project ?? target.url}…`,
            cancellable: false,
          },
          async () => {
            await cloneRepository(workspaceHandle, target.url, {
              credentialsProvider:
                token != null ? async () => ({ username: "oauth2", password: token }) : undefined,
              ref: settings.defaultBranch.length > 0 ? settings.defaultBranch : undefined,
              depth: settings.cloneDepth > 0 ? settings.cloneDepth : undefined,
            });
          },
        );

        if (target.project != null) {
          await updateGitLabSetting(vscode, context.workspaceRootUri, "project", target.project);
        }

        await vscode.window.showInformationMessage(
          `GitLab: cloned "${target.project ?? target.url}" into the workspace.`,
        );

        try {
          await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
        } catch {
          // Explorer refresh is best-effort.
        }

        try {
          await vscode.commands.executeCommand("dataverseGit.refresh");
        } catch {
          // The git extension may be disabled; the clone still succeeded.
        }
      } catch (error) {
        outputChannel.appendLine(
          `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
        );
        outputChannel.show(true);

        await vscode.window.showErrorMessage(
          "GitLab: failed to clone the repository (see GitLab output).",
        );
      }
    });

    const openProjectCommand = vscode.commands.registerCommand(COMMAND_OPEN_PROJECT, async () => {
      const settings = readGitLabSettings(vscode, context.workspaceRootUri);
      const resolved = await resolveProject(vscode, context.workspaceRootUri);

      let project = resolved?.project ?? settings.project;

      if (project.length === 0) {
        const input = await vscode.window.showInputBox({
          title: "GitLab: Open Project in Browser",
          prompt: "Project path (group/project).",
          placeHolder: "my-group/my-project",
          ignoreFocusOut: true,
        });

        project = input?.trim() ?? "";
      }

      if (project.length === 0) {
        return;
      }

      let webUrl = projectWebUrl(settings.baseUrl, project);
      const token = await secrets.get("token");

      if (token != null) {
        try {
          const client = new GitLabClient({
            baseUrl: settings.baseUrl,
            token,
            http,
          });

          webUrl = (await client.getProject(project)).web_url;
        } catch {
          // Fall back to the derived web URL when the API lookup fails.
        }
      }

      void vscode.env.openExternal(vscode.Uri.parse(webUrl));
    });

    const openSettingsCommand = vscode.commands.registerCommand(COMMAND_OPEN_SETTINGS, async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "dataverseIde.gitlab");
    });

    type MrPick = { label: string; description: string; detail: string; url: string };

    const showMergeRequestsCommand = vscode.commands.registerCommand(COMMAND_SHOW_MRS, async () => {
      const ready = await ensureClient();

      if (ready == null) {
        return;
      }

      const { client, project } = ready;

      try {
        const mergeRequests: GitLabMergeRequest[] = await client.listMergeRequests(
          project.project,
          {
            state: "opened",
          },
        );

        if (mergeRequests.length === 0) {
          await vscode.window.showInformationMessage(
            `GitLab: no open merge requests on ${project.project}.`,
          );

          return;
        }

        const selected = await vscode.window.showQuickPick<MrPick>(
          mergeRequests.map((mr) => ({
            label: `!${mr.iid} ${mr.title}`,
            description: `${mr.state} · ${mr.source_branch} → ${mr.target_branch}`,
            detail: `${mr.author?.name ?? ""} · updated ${formatTimestamp(mr.updated_at)}`,
            url: mr.web_url,
          })),
          {
            title: `GitLab: Merge Requests (${project.project})`,
            placeHolder: "Select a merge request to open it in GitLab.",
            ignoreFocusOut: true,
          },
        );

        if (selected != null) {
          void vscode.env.openExternal(vscode.Uri.parse(selected.url));
        }
      } catch (error) {
        outputChannel.appendLine(
          `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
        );
        outputChannel.show(true);

        await vscode.window.showErrorMessage(
          "GitLab: failed to list merge requests (see GitLab output).",
        );
      }
    });

    const showIssuesCommand = vscode.commands.registerCommand(COMMAND_SHOW_ISSUES, async () => {
      const ready = await ensureClient();

      if (ready == null) {
        return;
      }

      const { client, project } = ready;

      try {
        const issues: GitLabIssue[] = await client.listIssues(project.project, { state: "opened" });

        if (issues.length === 0) {
          await vscode.window.showInformationMessage(
            `GitLab: no open issues on ${project.project}.`,
          );

          return;
        }

        const selected = await vscode.window.showQuickPick<MrPick>(
          issues.map((issue) => ({
            label: `#${issue.iid} ${issue.title}`,
            description: issue.state,
            detail: `${issue.author?.name ?? ""} · created ${formatTimestamp(issue.created_at)}`,
            url: issue.web_url,
          })),
          {
            title: `GitLab: Issues (${project.project})`,
            placeHolder: "Select an issue to open it in GitLab.",
            ignoreFocusOut: true,
          },
        );

        if (selected != null) {
          void vscode.env.openExternal(vscode.Uri.parse(selected.url));
        }
      } catch (error) {
        outputChannel.appendLine(
          `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
        );
        outputChannel.show(true);

        await vscode.window.showErrorMessage("GitLab: failed to list issues (see GitLab output).");
      }
    });

    const showPipelinesCommand = vscode.commands.registerCommand(
      COMMAND_SHOW_PIPELINES,
      async () => {
        const ready = await ensureClient();

        if (ready == null) {
          return;
        }

        const { client, project } = ready;

        try {
          const pipelines: GitLabPipeline[] = await client.listPipelines(project.project);

          if (pipelines.length === 0) {
            await vscode.window.showInformationMessage(
              `GitLab: no pipelines on ${project.project}.`,
            );

            return;
          }

          const selected = await vscode.window.showQuickPick<MrPick>(
            pipelines.map((pipeline) => ({
              label: `#${pipeline.id} ${pipeline.status}`,
              description: pipeline.ref ?? "",
              detail: `finished ${formatTimestamp(pipeline.finished_at)}`,
              url: pipeline.web_url,
            })),
            {
              title: `GitLab: Pipelines (${project.project})`,
              placeHolder: "Select a pipeline to open it in GitLab.",
              ignoreFocusOut: true,
            },
          );

          if (selected != null) {
            void vscode.env.openExternal(vscode.Uri.parse(selected.url));
          }
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          );
          outputChannel.show(true);

          await vscode.window.showErrorMessage(
            "GitLab: failed to list pipelines (see GitLab output).",
          );
        }
      },
    );

    const createIssueCommand = vscode.commands.registerCommand(COMMAND_CREATE_ISSUE, async () => {
      const ready = await ensureClient();

      if (ready == null) {
        return;
      }

      const { client, project } = ready;

      const title = await vscode.window.showInputBox({
        title: "GitLab: New Issue",
        prompt: "Issue title.",
        ignoreFocusOut: true,
      });

      if (title == null || title.trim().length === 0) {
        return;
      }

      const description = await vscode.window.showInputBox({
        title: "GitLab: New Issue",
        prompt: "Description (optional).",
        ignoreFocusOut: true,
      });

      try {
        const issue: GitLabIssue = await client.createIssue(project.project, {
          title: title.trim(),
          description: description?.trim() || undefined,
        });

        await vscode.window.showInformationMessage(
          `GitLab: created issue #${issue.iid} "${issue.title}".`,
        );

        void vscode.env.openExternal(vscode.Uri.parse(issue.web_url));
      } catch (error) {
        outputChannel.appendLine(
          `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
        );
        outputChannel.show(true);

        await vscode.window.showErrorMessage(
          "GitLab: failed to create the issue (see GitLab output).",
        );
      }
    });

    const createMergeRequestCommand = vscode.commands.registerCommand(
      COMMAND_CREATE_MR,
      async () => {
        const ready = await ensureClient();

        if (ready == null) {
          return;
        }

        const { client, project } = ready;

        let currentBranch: string | undefined;

        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(context.workspaceRootUri, ".git", "HEAD"),
          );

          const head = new TextDecoder().decode(bytes).trim();

          const match = /^ref: refs\/heads\/(.+)$/.exec(head);

          currentBranch = match?.[1];
        } catch {
          currentBranch = undefined;
        }

        const sourceBranch = await vscode.window.showInputBox({
          title: "GitLab: New Merge Request",
          prompt: "Source branch.",
          value: currentBranch ?? "",
          ignoreFocusOut: true,
        });

        if (sourceBranch == null || sourceBranch.trim().length === 0) {
          return;
        }

        const targetBranch = await vscode.window.showInputBox({
          title: "GitLab: New Merge Request",
          prompt: "Target branch.",
          value: readGitLabSettings(vscode, context.workspaceRootUri).defaultBranch || "main",
          ignoreFocusOut: true,
        });

        if (targetBranch == null || targetBranch.trim().length === 0) {
          return;
        }

        const title = await vscode.window.showInputBox({
          title: "GitLab: New Merge Request",
          prompt: "Merge request title.",
          ignoreFocusOut: true,
        });

        if (title == null || title.trim().length === 0) {
          return;
        }

        try {
          const mr: GitLabMergeRequest = await client.createMergeRequest(project.project, {
            sourceBranch: sourceBranch.trim(),
            targetBranch: targetBranch.trim(),
            title: title.trim(),
            removeSourceBranch: true,
          });

          await vscode.window.showInformationMessage(
            `GitLab: created merge request !${mr.iid} "${mr.title}".`,
          );

          void vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          );
          outputChannel.show(true);

          await vscode.window.showErrorMessage(
            "GitLab: failed to create the merge request (see GitLab output).",
          );
        }
      },
    );

    outputChannel.appendLine("[gitlab] extension activated.");

    return {
      dispose() {
        gitlabPanel.dispose();
        connectCommand.dispose();
        disconnectCommand.dispose();
        selectProjectCommand.dispose();
        cloneCommand.dispose();
        openProjectCommand.dispose();
        openSettingsCommand.dispose();
        showMergeRequestsCommand.dispose();
        showIssuesCommand.dispose();
        showPipelinesCommand.dispose();
        createIssueCommand.dispose();
        createMergeRequestCommand.dispose();
      },
    };
  },
} satisfies IdeExtension;

export type { GitLabProject };
export type { IdeExtensionHttp, IdeExtensionSecretStore };
