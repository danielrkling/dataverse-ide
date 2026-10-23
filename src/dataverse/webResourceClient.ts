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
  
      const response = await fetch(
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
        const response = await fetch(
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
      const response = await fetch(
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
  
      const response = await fetch(
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