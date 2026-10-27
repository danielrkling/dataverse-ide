import type { IdeExtensionHttp } from '../api.js'

/*
 * GitLab REST API v4 client.
 *
 * Docs: https://docs.gitlab.com/ee/api/rest/
 * Auth: personal access token via the PRIVATE-TOKEN header (works for both
 * gitlab.com and self-hosted).
 */

export type GitLabProject = {
  id: number
  name: string
  path_with_namespace: string
  web_url: string
  default_branch?: string
}

export type GitLabMergeRequest = {
  iid: number
  title: string
  state: string
  web_url: string
  source_branch: string
  target_branch: string
  author?: { name?: string }
  created_at?: string
  updated_at?: string
}

export type GitLabIssue = {
  iid: number
  title: string
  state: string
  web_url: string
  author?: { name?: string }
  created_at?: string
}

export type GitLabPipeline = {
  id: number
  status: string
  ref?: string
  web_url: string
  created_at?: string
  finished_at?: string
}

export type GitLabClientOptions = {
  baseUrl: string
  token: string
  http: IdeExtensionHttp
}

export class GitLabClient {
  constructor(private readonly options: GitLabClientOptions) {}

  private async request<T>(
    apiPath: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/api/v4${apiPath}`

    const response = await this.options.http(url, {
      ...init,

      headers: {
        'PRIVATE-TOKEN': this.options.token,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    if (!response.ok) {
      let detail = ''

      try {
        const body = (await response.json()) as { message?: string }

        detail =
          typeof body?.message === 'string' ? `: ${body.message}` : ''
      } catch {
        // ignore parse errors, keep the status line
      }

      throw new Error(
        `GitLab API ${response.status} ${response.statusText}${detail}`,
      )
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  async getCurrentUser(): Promise<{ username: string; name?: string }> {
    return this.request<{ username: string; name?: string }>('/user')
  }

  async getProject(
    projectIdOrPath: string | number,
  ): Promise<GitLabProject> {
    const encoded =
      typeof projectIdOrPath === 'number'
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath)

    return this.request<GitLabProject>(`/projects/${encoded}`)
  }

  async listMergeRequests(
    projectIdOrPath: string | number,
    query?: { state?: 'opened' | 'closed' | 'merged' },
  ): Promise<GitLabMergeRequest[]> {
    const encoded =
      typeof projectIdOrPath === 'number'
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath)

    const state = query?.state ?? 'opened'

    return this.request<GitLabMergeRequest[]>(
      `/projects/${encoded}/merge_requests?state=${state}&per_page=50&order_by=updated_at`,
    )
  }

  async listIssues(
    projectIdOrPath: string | number,
    query?: { state?: 'opened' | 'closed' },
  ): Promise<GitLabIssue[]> {
    const encoded =
      typeof projectIdOrPath === 'number'
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath)

    const state = query?.state ?? 'opened'

    return this.request<GitLabIssue[]>(
      `/projects/${encoded}/issues?state=${state}&per_page=50`,
    )
  }

  async listPipelines(
    projectIdOrPath: string | number,
  ): Promise<GitLabPipeline[]> {
    const encoded =
      typeof projectIdOrPath === 'number'
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath)

    return this.request<GitLabPipeline[]>(
      `/projects/${encoded}/pipelines?per_page=20`,
    )
  }

  async createMergeRequest(
    projectIdOrPath: string | number,
    input: {
      sourceBranch: string
      targetBranch?: string
      title: string
      description?: string
      removeSourceBranch?: boolean
    },
  ): Promise<GitLabMergeRequest> {
    const encoded =
      typeof projectIdOrPath === 'number'
        ? String(projectIdOrPath)
        : encodeURIComponent(projectIdOrPath)

    return this.request<GitLabMergeRequest>(
      `/projects/${encoded}/merge_requests`,
      {
        method: 'POST',

        body: JSON.stringify({
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch ?? 'main',
          title: input.title,
          description: input.description,
          remove_source_branch: input.removeSourceBranch ?? true,
        }),
      },
    )
  }
}

/*
 * Extract the "namespace/project" path from the git origin URL (https):
 *   https://gitlab.com/group/subgroup/repo.git -> group/subgroup/repo
 */
export function projectPathFromRemoteUrl(
  remoteUrl: string,
): { host: string; path: string } | undefined {
  try {
    const url = new URL(remoteUrl)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined
    }

    let path = decodeURIComponent(url.pathname).replace(/^\//, '')

    if (path.endsWith('.git')) {
      path = path.slice(0, -4)
    }

    if (path.length === 0) {
      return undefined
    }

    return { host: url.host, path }
  } catch {
    return undefined
  }
}
