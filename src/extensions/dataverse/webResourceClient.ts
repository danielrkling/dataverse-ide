export type DataverseWebResource = {
    webresourceid: string
    name: string
    webresourcetype: number
    createdon?: string
    modifiedon?: string
  }
  
  export type DataverseWebResourceClientOptions = {
    apiBaseUrl?: string
    solutionUniqueName?: string
  }

  export type DataverseSolution = {
    uniquename: string
    friendlyname?: string
    isvisible?: boolean
  }

  export type DataverseUser = {
    id: string
    fullName: string
    email: string
  }
  
  const VALID_PREFIX = /^[A-Za-z].*_/
  
  const WEB_RESOURCE_TYPES: Record<string, number> = {
    html: 1,
    htm: 1,
    css: 2,
    js: 3,
    mjs: 3,
    xml: 4,
    txt: 4,
    png: 5,
    jpg: 6,
    jpeg: 6,
    gif: 7,
    xap: 8,
    xsl: 9,
    xslt: 9,
    ico: 10,
    svg: 11,
    resx: 12,
  }
  
  function normalizeApiBaseUrl(value?: string): string {
    const baseUrl = value?.trim() || window.location.origin
  
    return baseUrl.replace(/\/+$/, '')
  }
  
  function getHeaders(
    solutionUniqueName?: string,
  ): Headers {
    const headers = new Headers({
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      Prefer: 'return=representation',
    })
  
    if (solutionUniqueName?.trim()) {
      headers.set(
        'MSCRM.SolutionUniqueName',
        solutionUniqueName.trim(),
      )
    }
  
    return headers
  }
  
  function escapeODataString(value: string): string {
    return value.replaceAll("'", "''")
  }

  /*
   * Request resilience (ported from dataverse-dev-tools' dataverse service):
   *
   * - Every request runs under an abort timeout (30s default).
   * - 429 responses honor the Retry-After header (seconds or HTTP date) and
   *   are retried up to 3 times.
   * - Transient 5xx responses and network errors are retried with
   *   exponential backoff (300ms base, max 3 attempts).
   */
  const REQUEST_TIMEOUT_MS = 60000
  const MAX_RETRIES = 3
  const RETRY_BASE_DELAY_MS = 300

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function parseRetryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('Retry-After')

    if (header == null) {
      return undefined
    }

    const seconds = Number(header)

    if (!Number.isNaN(seconds)) {
      return Math.max(0, seconds * 1000)
    }

    const date = new Date(header).getTime()

    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now())
    }

    return undefined
  }

  async function fetchWithRetry(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let lastError: unknown

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
      }

      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      )

      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        })

        if (response.status === 429) {
          if (attempt < MAX_RETRIES) {
            const retryAfterMs = parseRetryAfterMs(response) ?? 2000

            await sleep(retryAfterMs)

            continue
          }
        } else if (
          response.status >= 500 &&
          response.status < 600 &&
          attempt < MAX_RETRIES
        ) {
          continue
        }

        return response
      } catch (error) {
        /*
         * AbortError from our own timeout is treated like a network error:
         * retry, but the timeout is re-armed for the next attempt.
         */
        lastError = error

        if (attempt >= MAX_RETRIES) {
          break
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Request failed after retries.')
  }
  
  function getExtension(name: string): string | undefined {
    const finalSegment = name.split('/').at(-1)
    const extension = finalSegment?.split('.').at(-1)?.toLowerCase()
  
    return extension
  }
  
  export function getWebResourceType(
    name: string,
  ): number | undefined {
    const extension = getExtension(name)
  
    return extension == null
      ? undefined
      : WEB_RESOURCE_TYPES[extension]
  }
  
  export function isValidWebResourceName(name: string): boolean {
    return (
      VALID_PREFIX.test(name) &&
      getWebResourceType(name) != null
    )
  }
  
  /*
   * Binary-safe conversion.
   *
   * Do not use encodeURIComponent()/btoa() text encoding here. That works for
   * UTF-8 text but corrupts binary images, ICO files, and other web resources.
   */
  function toBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000
    let binary = ''
  
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += chunkSize
    ) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + chunkSize, bytes.byteLength),
      )
  
      binary += String.fromCharCode(...chunk)
    }
  
    return btoa(binary)
  }
  
  async function getErrorMessage(
    response: Response,
  ): Promise<string> {
    const body = await response.text()
  
    if (body.length === 0) {
      return `HTTP ${response.status} ${response.statusText}`
    }
  
    try {
      const json = JSON.parse(body) as {
        error?: {
          message?: string
        }
      }
  
      if (json.error?.message) {
        return `HTTP ${response.status}: ${json.error.message}`
      }
    } catch {
      // Return the raw response body below.
    }
  
    return `HTTP ${response.status}: ${body}`
  }
  
  export class DataverseWebResourceClient {
    private readonly apiBaseUrl: string
    private readonly solutionUniqueName?: string
  
    private readonly cache = new Map<
      string,
      DataverseWebResource
    >()
  
    constructor(
      options: DataverseWebResourceClientOptions = {},
    ) {
      this.apiBaseUrl = normalizeApiBaseUrl(
        options.apiBaseUrl,
      )
  
      this.solutionUniqueName =
        options.solutionUniqueName?.trim() || undefined
    }
  
    private get apiUrl(): string {
      return `${this.apiBaseUrl}/api/data/v9.2`
    }
  
    private get requestHeaders(): Headers {
      return getHeaders(this.solutionUniqueName)
    }

    /*
     * Visible solutions in the org, used by the Dataverse side panel's
     * solution dropdown.
     */
    async listSolutions(): Promise<DataverseSolution[]> {
      const search = new URLSearchParams({
        $select: 'uniquename,friendlyname,isvisible',
        $filter: 'isvisible eq true',
        $top: '200',
      })

      const response = await fetchWithRetry(
        `${this.apiUrl}/solutions?${search.toString()}`,
        {
          headers: this.requestHeaders,
        },
      )

      if (!response.ok) {
        throw new Error(
          `Unable to list solutions: ${await getErrorMessage(response)}`,
        )
      }

      const body = await response.json() as {
        value?: {
          uniquename?: string
          friendlyname?: string
          isvisible?: boolean
        }[]
      }

      return (body.value ?? [])
        .filter((solution) => typeof solution.uniquename === 'string')
        .map((solution) => ({
          uniquename: solution.uniquename as string,
          friendlyname: solution.friendlyname,
          isvisible: solution.isvisible,
        }))
    }

    /*
     * Current Dataverse user (WhoAmI + systemusers), used to seed the git
     * commit author and the IDE user identity.
     */
    async getCurrentUser(): Promise<DataverseUser> {
      const whoResponse = await fetchWithRetry(
        `${this.apiUrl}/WhoAmI`,
        {
          headers: this.requestHeaders,
        },
      )

      if (!whoResponse.ok) {
        throw new Error(
          `WhoAmI failed: ${await getErrorMessage(whoResponse)}`,
        )
      }

      const who = await whoResponse.json() as { UserId?: string }

      if (who.UserId == null) {
        throw new Error('WhoAmI did not return a user ID.')
      }

      const userResponse = await fetchWithRetry(
        `${this.apiUrl}/systemusers(${who.UserId})?$select=fullname,internalemailaddress`,
        {
          headers: this.requestHeaders,
        },
      )

      if (!userResponse.ok) {
        throw new Error(
          `Reading the system user failed: ${await getErrorMessage(userResponse)}`,
        )
      }

      const user = await userResponse.json() as {
        fullname?: string
        internalemailaddress?: string
      }

      return {
        id: who.UserId,
        fullName: user.fullname?.trim() || '',
        email: user.internalemailaddress?.trim() || '',
      }
    }

    async getWebResource(
      name: string,
    ): Promise<DataverseWebResource | undefined> {
      const cached = this.cache.get(name)
  
      if (cached != null) {
        return cached
      }
  
      const filter = `name eq '${escapeODataString(name)}'`
  
      const search = new URLSearchParams({
        $select:
          'name,webresourceid,webresourcetype,modifiedon,createdon',
        $filter: filter,
        $top: '1',
      })
  
      const response = await fetchWithRetry(
        `${this.apiUrl}/webresourceset?${search.toString()}`,
        {
          headers: this.requestHeaders,
        },
      )
  
      if (!response.ok) {
        throw new Error(
          `Unable to query "${name}": ${await getErrorMessage(response)}`,
        )
      }
  
      const body = await response.json() as {
        value?: DataverseWebResource[]
      }
  
      const resource = body.value?.[0]
  
      if (resource != null) {
        this.cache.set(name, resource)
      }
  
      return resource
    }
  
    async uploadWebResource(
      name: string,
      content: Uint8Array,
    ): Promise<DataverseWebResource> {
      if (!isValidWebResourceName(name)) {
        throw new Error(
          `"${name}" is not a supported Dataverse web resource name.`,
        )
      }
  
      const webresourcetype = getWebResourceType(name)
  
      if (webresourcetype == null) {
        throw new Error(
          `"${name}" has an unsupported web resource extension.`,
        )
      }
  
      const base64Content = toBase64(content)
      const existing = await this.getWebResource(name)
  
      /*
       * Existing resource: update only the content payload.
       */
      if (existing != null) {
        const response = await fetchWithRetry(
          `${this.apiUrl}/webresourceset(${existing.webresourceid})/content`,
          {
            method: 'PUT',
            headers: this.requestHeaders,
            body: JSON.stringify({
              value: base64Content,
            }),
          },
        )
  
        if (!response.ok) {
          throw new Error(
            `Unable to update "${name}": ${await getErrorMessage(response)}`,
          )
        }
  
        return existing
      }
  
      /*
       * New resource: create name, type, and Base64 content together.
       */
      const response = await fetchWithRetry(
        `${this.apiUrl}/webresourceset?$select=name,webresourceid,webresourcetype`,
        {
          method: 'POST',
          headers: this.requestHeaders,
          body: JSON.stringify({
            name,
            webresourcetype,
            content: base64Content,
          }),
        },
      )
  
      if (!response.ok) {
        throw new Error(
          `Unable to create "${name}": ${await getErrorMessage(response)}`,
        )
      }
  
      const created = await response.json() as DataverseWebResource
  
      if (!created.webresourceid) {
        throw new Error(
          `Dataverse created "${name}" but did not return its web resource ID.`,
        )
      }
  
      this.cache.set(name, created)
  
      return created
    }
  
    async publishWebResources(
      resources: DataverseWebResource[],
    ): Promise<void> {
      const ids = [
        ...new Set(
          resources
            .map((resource) => resource.webresourceid)
            .filter((id) => id.length > 0),
        ),
      ]
  
      if (ids.length === 0) {
        return
      }
  
      const parameterXml =
        '<importexportxml><webresources>' +
        ids
          .map(
            (id) => `<webresource>${id}</webresource>`,
          )
          .join('') +
        '</webresources></importexportxml>'
  
      const response = await fetchWithRetry(
        `${this.apiUrl}/PublishXml`,
        {
          method: 'POST',
          headers: this.requestHeaders,
          body: JSON.stringify({
            ParameterXml: parameterXml,
          }),
        },
      )
  
      if (!response.ok) {
        throw new Error(
          `Unable to publish web resources: ${await getErrorMessage(response)}`,
        )
      }
    }
  }