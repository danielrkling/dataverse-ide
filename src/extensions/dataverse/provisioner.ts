import type { ResolvedSchema } from "./schema.js";
import type { SchemaPlan, SchemaPlanItem } from "./schemaPlan.js";

import {
  buildAttributeDefinition,
  buildEntityDefinition,
  buildRelationshipDefinition,
} from "./metadataDefinitions.js";

import type { DataverseMetadataClient } from "./metadataClient.js";

export type ProvisionFailure = {
  item: string;
  message: string;
};

export type ProvisionResult = {
  createdTables: string[];
  createdColumns: string[];
  createdRelationships: string[];
  publishedEntities: string[];
  failures: ProvisionFailure[];
};

export type ProvisionProgress = (message: string) => void;

function itemKey(item: SchemaPlanItem): string {
  return `${item.kind}:${item.table}:${item.column ?? ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * Execute a plan produced by buildSchemaPlan().
 *
 * Order matters:
 *   1. tables (the primary name column is created with the table)
 *   2. scalar columns
 *   3. lookups (relationships), after every target table exists
 *   4. one publish for every table that changed
 *
 * Failures are collected and the remaining independent work continues, so a
 * single bad column does not stop the rest. Re-running is safe: the planner
 * sees the successfully created components and skips them.
 */
export async function applySchemaPlan(
  client: DataverseMetadataClient,
  schema: ResolvedSchema,
  plan: SchemaPlan,
  onProgress?: ProvisionProgress,
): Promise<ProvisionResult> {
  const creates = new Set(
    plan.items.filter((item) => item.action === "create").map((item) => itemKey(item)),
  );

  const result: ProvisionResult = {
    createdTables: [],
    createdColumns: [],
    createdRelationships: [],
    publishedEntities: [],
    failures: [],
  };

  const failedTables = new Set<string>();
  const entitiesToPublish = new Set<string>();

  for (const table of schema.tables) {
    if (!creates.has(`table:${table.logicalName}:`)) {
      continue;
    }

    onProgress?.(`Creating table ${table.logicalName}…`);

    try {
      await client.createEntity(buildEntityDefinition(table, schema.languageCode));
      result.createdTables.push(table.logicalName);
      entitiesToPublish.add(table.logicalName);
    } catch (error) {
      failedTables.add(table.logicalName);
      result.failures.push({
        item: `table ${table.logicalName}`,
        message: errorMessage(error),
      });
    }
  }

  for (const table of schema.tables) {
    if (failedTables.has(table.logicalName)) {
      continue;
    }

    for (const column of table.columns) {
      if (
        column.type === "lookup" ||
        !creates.has(`column:${table.logicalName}:${column.logicalName}`)
      ) {
        continue;
      }

      onProgress?.(`Creating column ${table.logicalName}.${column.logicalName}…`);

      try {
        await client.createAttribute(
          table.logicalName,
          buildAttributeDefinition(column, schema.languageCode),
        );

        result.createdColumns.push(`${table.logicalName}.${column.logicalName}`);
        entitiesToPublish.add(table.logicalName);
      } catch (error) {
        result.failures.push({
          item: `column ${table.logicalName}.${column.logicalName}`,
          message: errorMessage(error),
        });
      }
    }
  }

  for (const table of schema.tables) {
    if (failedTables.has(table.logicalName)) {
      continue;
    }

    for (const column of table.columns) {
      if (
        column.type !== "lookup" ||
        !creates.has(`lookup:${table.logicalName}:${column.logicalName}`)
      ) {
        continue;
      }

      onProgress?.(
        `Creating lookup ${table.logicalName}.${column.logicalName} → ${column.targetLogicalName}…`,
      );

      try {
        await client.createRelationship(
          buildRelationshipDefinition(table, column, schema.languageCode),
        );

        result.createdRelationships.push(`${table.logicalName}.${column.logicalName}`);
        entitiesToPublish.add(table.logicalName);
      } catch (error) {
        result.failures.push({
          item: `lookup ${table.logicalName}.${column.logicalName}`,
          message: errorMessage(error),
        });
      }
    }
  }

  if (entitiesToPublish.size > 0) {
    onProgress?.(`Publishing ${entitiesToPublish.size} table(s)…`);

    try {
      await client.publishEntities([...entitiesToPublish]);
      result.publishedEntities.push(...entitiesToPublish);
    } catch (error) {
      result.failures.push({ item: "publish", message: errorMessage(error) });
    }
  }

  return result;
}
