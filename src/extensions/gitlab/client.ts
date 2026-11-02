import type { IdeExtensionHttp } from "../api.js";

/*
 * GitLab REST API v4 client.
 *
 * Docs: https://docs.gitlab.com/ee/api/rest/
 * Auth: personal access token via the PRIVATE-TOKEN header (works for both
 * gitlab.com and self-hosted).
 */

export type GitLabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch?: string;
  description?: string;
  visibility?: string;
  last_activity_at?: string;
};

export type GitLabMergeRequest = {
  iid: number;
  title: string;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author?: { name?: string };
  created_at?: string;
  updated_at?: string;
};

export type GitLabIssue = {
  iid: number;
  title: string;
  state: string;
  web_url: string;
  author?: { name?: string };
  created_at?: string;
};

export type GitLabPipeline = {
  id: number;
  status: string;
  ref?: string;
  web_url: string;
  created_at?: string;
  finished_at?: string;
};

export type GitLabClientOptions = {
  baseUrl: string;
  token: string;
  http: IdeExtensionHttp;
};

export class GitLabClient {
  constructor(private readonly options: GitLabClientOptions) {}

  private async request<T>(apiPath: string, init?: RequestInit): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/api/v4${apiPath}`;

    const response = await this.options.http(url, {
      ...init,

      headers: {
        "PRIVATE-TOKEN": this.options.token,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      let detail = "";

      try {
        const body = (await response.json()) as { message?: string };

        detail = typeof body?.message === "string" ? `: ${body.message}` : "";
      } catch {
        // ignore parse errors, keep the status line
      }

      throw new Error(`GitLab API ${response.status} ${response.statusText}${detail}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async getCurrentUser(): Promise<{ username: string; name?: string }> {
    return this.request<{ username: string; name?: string }>("/user");
  }

  async getProject(projectIdOrPath: string | number): Promise<GitLabProject> {
    const encoded =
      typeof projectIdOrPath === "number"
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath);

    return this.request<GitLabProject>(`/projects/${encoded}`);
  }

  async listProjects(options?: {
    membership?: boolean;
    search?: string;
    perPage?: number;
  }): Promise<GitLabProject[]> {
    const params = new URLSearchParams({
      simple: "true",
      order_by: "last_activity_at",
      per_page: String(options?.perPage ?? 100),
    });

    if (options?.membership ?? true) {
      params.set("membership", "true");
    }

    if (options?.search != null && options.search.trim().length > 0) {
      params.set("search", options.search.trim());
    }

    return this.request<GitLabProject[]>(`/projects?${params.toString()}`);
  }

  async listMergeRequests(
    projectIdOrPath: string | number,
    query?: { state?: "opened" | "closed" | "merged" },
  ): Promise<GitLabMergeRequest[]> {
    const encoded =
      typeof projectIdOrPath === "number"
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath);

    const state = query?.state ?? "opened";

    return this.request<GitLabMergeRequest[]>(
      `/projects/${encoded}/merge_requests?state=${state}&per_page=50&order_by=updated_at`,
    );
  }

  async listIssues(
    projectIdOrPath: string | number,
    query?: { state?: "opened" | "closed" },
  ): Promise<GitLabIssue[]> {
    const encoded =
      typeof projectIdOrPath === "number"
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath);

    const state = query?.state ?? "opened";

    return this.request<GitLabIssue[]>(`/projects/${encoded}/issues?state=${state}&per_page=50`);
  }

  async listPipelines(projectIdOrPath: string | number): Promise<GitLabPipeline[]> {
    const encoded =
      typeof projectIdOrPath === "number"
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath);

    return this.request<GitLabPipeline[]>(`/projects/${encoded}/pipelines?per_page=20`);
  }

  async createIssue(
    projectIdOrPath: string | number,
    input: { title: string; description?: string },
  ): Promise<GitLabIssue> {
    const encoded =
      typeof projectIdOrPath === "number"
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath);

    return this.request<GitLabIssue>(`/projects/${encoded}/issues`, {
      method: "POST",

      body: JSON.stringify({
        title: input.title,
        description: input.description,
      }),
    });
  }

  async createMergeRequest(
    projectIdOrPath: string | number,
    input: {
      sourceBranch: string;
      targetBranch?: string;
      title: string;
      description?: string;
      removeSourceBranch?: boolean;
    },
  ): Promise<GitLabMergeRequest> {
    const encoded =
      typeof projectIdOrPath === "number"
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath);

    return this.request<GitLabMergeRequest>(`/projects/${encoded}/merge_requests`, {
      method: "POST",

      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch ?? "main",
        title: input.title,
        description: input.description,
        remove_source_branch: input.removeSourceBranch ?? true,
      }),
    });
  }
}

/*
 * Extract the "namespace/project" path from a git remote URL:
 *   https://gitlab.com/group/subgroup/repo.git -> group/subgroup/repo
 *   git@gitlab.com:group/subgroup/repo.git     -> group/subgroup/repo
 *   ssh://git@gitlab.com/group/repo.git        -> group/repo
 */
export function projectPathFromRemoteUrl(
  remoteUrl: string,
): { host: string; path: string } | undefined {
  const value = remoteUrl.trim();

  if (value.length === 0) {
    return undefined;
  }

  let host: string | undefined;
  let pathname: string | undefined;

  try {
    const url = new URL(value);

    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ssh:") {
      host = url.host;
      pathname = url.pathname;
    }
  } catch {
    // Fall through to the scp-like syntax below.
  }

  if (host == null || pathname == null) {
    const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(value);

    if (scp == null) {
      return undefined;
    }

    host = scp[1];
    pathname = scp[2];
  }

  let path = decodeURIComponent(pathname).replace(/^\/+/, "");

  if (path.endsWith(".git")) {
    path = path.slice(0, -4);
  }

  if (path.length === 0) {
    return undefined;
  }

  return { host, path };
}
