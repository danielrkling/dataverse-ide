import {
  PUBLISH_TIMEOUT_MS,
  createDataverseHeaders,
  escapeODataString,
  fetchWithRetry,
  getDataverseErrorMessage,
  normalizeApiBaseUrl,
} from "./http.js";

import type {
  ExistingAttributeMetadata,
  ExistingEntityMetadata,
  SchemaMetadataReader,
} from "./schemaPlan.js";

export type DataverseMetadataClientOptions = {
  apiBaseUrl?: string;
  solutionUniqueName?: string;
};

type AttributeResponse = {
  LogicalName?: string;
  AttributeType?: string;
  AttributeTypeName?: {
    Value?: string;
  };
};

type EntityResponse = {
  LogicalName?: string;
  Attributes?: AttributeResponse[];
};

/*
 * Minimal Web API client for additive metadata changes.
 *
 * Reads are used by the planner; writes are only ever POSTs. There is no
 * update or delete method here on purpose: changing an existing table or
 * column is an explicit user action in Dataverse.
 */
export class DataverseMetadataClient implements SchemaMetadataReader {
  private readonly apiBaseUrl: string;
  private readonly solutionUniqueName?: string;

  constructor(options: DataverseMetadataClientOptions = {}) {
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.solutionUniqueName = options.solutionUniqueName?.trim() || undefined;
  }

  private get apiUrl(): string {
    return `${this.apiBaseUrl}/api/data/v9.2`;
  }

  private get requestHeaders(): Headers {
    return createDataverseHeaders(this.solutionUniqueName);
  }

  /** Table metadata plus its attributes, or undefined when the table does not exist. */
  async getEntity(logicalName: string): Promise<ExistingEntityMetadata | undefined> {
    let response = await this.fetchEntity(logicalName, true);

    /*
     * AttributeTypeName is a complex property. If this org/version rejects it
     * inside $expand, retry with the primitive AttributeType only.
     */
    if (response.status === 400) {
      response = await this.fetchEntity(logicalName, false);
    }

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(
        `Unable to read table "${logicalName}": ${await getDataverseErrorMessage(response)}`,
      );
    }

    const body = (await response.json()) as {
      value?: EntityResponse[];
      LogicalName?: string;
      Attributes?: AttributeResponse[];
    };

    const record = body.value?.[0] ?? body;
    const attributes = new Map<string, ExistingAttributeMetadata>();

    for (const attribute of record.Attributes ?? []) {
      if (typeof attribute.LogicalName !== "string") {
        continue;
      }

      attributes.set(attribute.LogicalName.toLowerCase(), {
        logicalName: attribute.LogicalName,
        attributeTypeName: attribute.AttributeTypeName?.Value,
        attributeType: attribute.AttributeType,
      });
    }

    return { logicalName, attributes };
  }

  private fetchEntity(logicalName: string, includeTypeName: boolean): Promise<Response> {
    const attributeSelect = includeTypeName
      ? "LogicalName,AttributeType,AttributeTypeName"
      : "LogicalName,AttributeType";

    const search = new URLSearchParams({
      $select: "LogicalName",
      $expand: `Attributes($select=${attributeSelect})`,
    });

    return fetchWithRetry(
      `${this.apiUrl}/EntityDefinitions(LogicalName='${escapeODataString(logicalName)}')?${search.toString()}`,
      { headers: this.requestHeaders },
    );
  }

  async createEntity(definition: Record<string, unknown>): Promise<void> {
    const response = await fetchWithRetry(
      `${this.apiUrl}/EntityDefinitions`,
      {
        method: "POST",
        headers: this.requestHeaders,
        body: JSON.stringify(definition),
      },
      { retryTimeouts: false },
    );

    if (!response.ok) {
      throw new Error(`Unable to create table: ${await getDataverseErrorMessage(response)}`);
    }
  }

  async createAttribute(
    entityLogicalName: string,
    definition: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetchWithRetry(
      `${this.apiUrl}/EntityDefinitions(LogicalName='${escapeODataString(entityLogicalName)}')/Attributes`,
      {
        method: "POST",
        headers: this.requestHeaders,
        body: JSON.stringify(definition),
      },
      { retryTimeouts: false },
    );

    if (!response.ok) {
      throw new Error(
        `Unable to create column on "${entityLogicalName}": ${await getDataverseErrorMessage(response)}`,
      );
    }
  }

  async createRelationship(definition: Record<string, unknown>): Promise<void> {
    const response = await fetchWithRetry(
      `${this.apiUrl}/RelationshipDefinitions`,
      {
        method: "POST",
        headers: this.requestHeaders,
        body: JSON.stringify(definition),
      },
      { retryTimeouts: false },
    );

    if (!response.ok) {
      throw new Error(`Unable to create relationship: ${await getDataverseErrorMessage(response)}`);
    }
  }

  async publishEntities(logicalNames: string[]): Promise<void> {
    const entities = [...new Set(logicalNames.filter((name) => name.length > 0))];

    if (entities.length === 0) {
      return;
    }

    const parameterXml =
      "<importexportxml><entities>" +
      entities.map((name) => `<entity>${name}</entity>`).join("") +
      "</entities></importexportxml>";

    const response = await fetchWithRetry(
      `${this.apiUrl}/PublishXml`,
      {
        method: "POST",
        headers: this.requestHeaders,
        body: JSON.stringify({ ParameterXml: parameterXml }),
      },
      {
        timeoutMs: PUBLISH_TIMEOUT_MS,
        retryTimeouts: false,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Unable to publish customizations: ${await getDataverseErrorMessage(response)}`,
      );
    }
  }
}
