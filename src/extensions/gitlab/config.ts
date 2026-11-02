import type * as vscodeType from "vscode";

/*
 * Shared GitLab settings.
 *
 * Every read goes through the workspace-scoped configuration so values written
 * from the sidebar panel (which stores them as workspace settings) are visible
 * to the extension commands as well.
 */

export const GITLAB_CONFIG_SECTION = "dataverseIde.gitlab";

export type GitLabSettings = {
  baseUrl: string;
  project: string;
  defaultBranch: string;
  cloneDepth: number;
};

export const GITLAB_SETTING_DEFAULTS: GitLabSettings = {
  baseUrl: "https://gitlab.com",
  project: "",
  defaultBranch: "",
  cloneDepth: 50,
};

export const GITLAB_CONFIGURATION_PROPERTIES = {
  "dataverseIde.gitlab.baseUrl": {
    type: "string",
    default: GITLAB_SETTING_DEFAULTS.baseUrl,
    description: "Base URL of the GitLab instance.",
  },
  "dataverseIde.gitlab.project": {
    type: "string",
    default: GITLAB_SETTING_DEFAULTS.project,
    description: "Project path as group/project. Leave empty to derive it from the origin remote.",
  },
  "dataverseIde.gitlab.defaultBranch": {
    type: "string",
    default: GITLAB_SETTING_DEFAULTS.defaultBranch,
    description:
      "Branch used when cloning or creating merge requests. Empty uses the project default branch.",
  },
  "dataverseIde.gitlab.cloneDepth": {
    type: "number",
    default: GITLAB_SETTING_DEFAULTS.cloneDepth,
    minimum: 0,
    description: "History depth for clones. Set 0 to clone the full history.",
  },
} as const;

export function normalizeBaseUrl(value: string | undefined): string {
  let trimmed = (value ?? "").trim();

  if (trimmed.length === 0) {
    return GITLAB_SETTING_DEFAULTS.baseUrl;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  return trimmed.replace(/\/+$/, "");
}

export function readGitLabSettings(
  vscode: typeof vscodeType,
  workspaceRootUri?: vscodeType.Uri,
): GitLabSettings {
  const config = vscode.workspace.getConfiguration(GITLAB_CONFIG_SECTION, workspaceRootUri ?? null);

  const cloneDepthValue = config.get<number>("cloneDepth", GITLAB_SETTING_DEFAULTS.cloneDepth);

  const cloneDepth = Number.isFinite(cloneDepthValue)
    ? Math.max(0, Math.floor(cloneDepthValue))
    : GITLAB_SETTING_DEFAULTS.cloneDepth;

  return {
    baseUrl: normalizeBaseUrl(config.get<string>("baseUrl", GITLAB_SETTING_DEFAULTS.baseUrl)),
    project: config.get<string>("project", GITLAB_SETTING_DEFAULTS.project).trim(),
    defaultBranch: config
      .get<string>("defaultBranch", GITLAB_SETTING_DEFAULTS.defaultBranch)
      .trim(),
    cloneDepth,
  };
}

export async function updateGitLabSetting<T>(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri | undefined,
  key: keyof GitLabSettings,
  value: T,
): Promise<void> {
  await vscode.workspace
    .getConfiguration(GITLAB_CONFIG_SECTION, workspaceRootUri ?? null)
    .update(
      key,
      value,
      workspaceRootUri != null
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
    );
}
