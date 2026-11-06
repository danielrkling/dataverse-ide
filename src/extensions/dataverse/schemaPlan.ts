import type {
  DataverseColumnType,
  ResolvedColumn,
  ResolvedSchema,
  ResolvedTable,
} from "./schema.js";

/*
 * Plan/diff layer for additive-only schema provisioning.
 *
 * The plan is computed entirely from metadata reads; it never writes. The
 * apply step consumes the same plan, so what the preview shows is exactly
 * what will be created.
 */

export type SchemaPlanKind = "table" | "column" | "lookup";
export type SchemaPlanAction = "create" | "skip" | "conflict";

export type SchemaPlanItem = {
  kind: SchemaPlanKind;
  action: SchemaPlanAction;
  table: string;
  column?: string;
  label: string;
  reason?: string;
};

export type SchemaPlan = {
  items: SchemaPlanItem[];
  tableCreates: number;
  columnCreates: number;
  lookupCreates: number;
  skips: number;
  conflicts: number;
  changedEntities: string[];
};

export type ExistingAttributeMetadata = {
  logicalName: string;
  attributeTypeName?: string;
  attributeType?: string;
};

export type ExistingEntityMetadata = {
  logicalName: string;
  attributes: Map<string, ExistingAttributeMetadata>;
};

export type SchemaMetadataReader = {
  getEntity(logicalName: string): Promise<ExistingEntityMetadata | undefined>;
};

const ATTRIBUTE_TYPE_NAMES: Record<DataverseColumnType, string> = {
  string: "StringType",
  memo: "MemoType",
  integer: "IntegerType",
  bigint: "BigIntType",
  decimal: "DecimalType",
  money: "MoneyType",
  boolean: "BooleanType",
  datetime: "DateTimeType",
  choice: "PicklistType",
  multichoice: "MultiSelectPicklistType",
  lookup: "LookupType",
};

const ATTRIBUTE_TYPES: Record<DataverseColumnType, string> = {
  string: "String",
  memo: "Memo",
  integer: "Integer",
  bigint: "BigInt",
  decimal: "Decimal",
  money: "Money",
  boolean: "Boolean",
  datetime: "DateTime",
  choice: "Picklist",
  multichoice: "Virtual",
  lookup: "Lookup",
};

export function expectedAttributeTypeName(type: DataverseColumnType): string {
  return ATTRIBUTE_TYPE_NAMES[type];
}

function columnKind(column: ResolvedColumn): SchemaPlanKind {
  return column.type === "lookup" ? "lookup" : "column";
}

function columnItem(
  table: ResolvedTable,
  column: ResolvedColumn,
  action: SchemaPlanAction,
  reason: string,
): SchemaPlanItem {
  return {
    kind: columnKind(column),
    action,
    table: table.logicalName,
    column: column.logicalName,
    label: column.displayName,
    reason,
  };
}

function existingTypeName(attribute: ExistingAttributeMetadata): string | undefined {
  return attribute.attributeTypeName ?? attribute.attributeType;
}

function typeMatches(attribute: ExistingAttributeMetadata, type: DataverseColumnType): boolean {
  const actual = existingTypeName(attribute);

  /* No type information: never claim a conflict we cannot prove. */
  if (actual == null) {
    return true;
  }

  /*
   * Prefer AttributeTypeName (e.g. MultiSelectPicklistType) but accept the
   * AttributeType spelling too (e.g. Virtual) in case $select did not return
   * the complex property.
   */
  return actual === expectedAttributeTypeName(type) || actual === ATTRIBUTE_TYPES[type];
}

/**
 * Read the org's current metadata and produce a create/skip/conflict plan.
 * Existing components are never updated or deleted.
 */
export async function buildSchemaPlan(
  schema: ResolvedSchema,
  reader: SchemaMetadataReader,
): Promise<SchemaPlan> {
  const items: SchemaPlanItem[] = [];
  const changedEntities = new Set<string>();

  for (const table of schema.tables) {
    const existing = await reader.getEntity(table.logicalName);

    if (existing == null) {
      items.push({
        kind: "table",
        action: "create",
        table: table.logicalName,
        label: table.displayName,
        reason: "table does not exist",
      });

      items.push({
        kind: "column",
        action: "create",
        table: table.logicalName,
        column: table.primaryName.logicalName,
        label: table.primaryName.displayName,
        reason: "primary name column, created with the table",
      });

      for (const column of table.columns) {
        items.push(columnItem(table, column, "create", "column does not exist"));
      }

      changedEntities.add(table.logicalName);

      continue;
    }

    items.push({
      kind: "table",
      action: "skip",
      table: table.logicalName,
      label: table.displayName,
      reason: "table already exists",
    });

    const existingPrimaryName = existing.attributes.get(table.primaryName.logicalName);

    if (existingPrimaryName == null) {
      items.push({
        kind: "column",
        action: "conflict",
        table: table.logicalName,
        column: table.primaryName.logicalName,
        label: table.primaryName.displayName,
        reason: "primary name column is missing and cannot be added to an existing table",
      });
    } else if (!typeMatches(existingPrimaryName, "string")) {
      items.push({
        kind: "column",
        action: "conflict",
        table: table.logicalName,
        column: table.primaryName.logicalName,
        label: table.primaryName.displayName,
        reason: `existing ${existingTypeName(existingPrimaryName) ?? "unknown type"}, expected StringType`,
      });
    } else {
      items.push({
        kind: "column",
        action: "skip",
        table: table.logicalName,
        column: table.primaryName.logicalName,
        label: table.primaryName.displayName,
        reason: "primary name column already exists",
      });
    }

    for (const column of table.columns) {
      const existingAttribute = existing.attributes.get(column.logicalName);

      if (existingAttribute == null) {
        items.push(columnItem(table, column, "create", "column does not exist"));
        changedEntities.add(table.logicalName);

        continue;
      }

      const expectedType = expectedAttributeTypeName(column.type);
      const actualType = existingTypeName(existingAttribute);

      if (!typeMatches(existingAttribute, column.type)) {
        items.push(
          columnItem(
            table,
            column,
            "conflict",
            `existing ${actualType ?? "unknown type"}, expected ${expectedType}`,
          ),
        );
      } else {
        items.push(columnItem(table, column, "skip", "column already exists"));
      }
    }
  }

  let tableCreates = 0;
  let columnCreates = 0;
  let lookupCreates = 0;
  let skips = 0;
  let conflicts = 0;

  for (const item of items) {
    if (item.action === "skip") {
      skips++;
    } else if (item.action === "conflict") {
      conflicts++;
    } else if (item.kind === "table") {
      tableCreates++;
    } else if (item.kind === "lookup") {
      lookupCreates++;
    } else {
      columnCreates++;
    }
  }

  return {
    items,
    tableCreates,
    columnCreates,
    lookupCreates,
    skips,
    conflicts,
    changedEntities: [...changedEntities],
  };
}

export type SchemaPlanContext = {
  apiBaseUrl: string;
  solution?: string;
  prefix: string;
};

function actionSymbol(action: SchemaPlanAction): string {
  switch (action) {
    case "create":
      return "+";
    case "skip":
      return "=";
    case "conflict":
      return "!";
  }
}

function kindLabel(kind: SchemaPlanKind): string {
  return kind === "lookup" ? "lookup" : kind;
}

/**
 * Render the plan as a markdown document with a diff-like block. The output
 * is also written to the extension's output channel.
 */
export function formatSchemaPlan(plan: SchemaPlan, context: SchemaPlanContext): string {
  const lines: string[] = [];

  lines.push("# Dataverse schema plan");
  lines.push("");
  lines.push(`- **Organisation:** ${context.apiBaseUrl}`);
  lines.push(`- **Publisher prefix:** \`${context.prefix}\``);

  if (context.solution != null && context.solution.length > 0) {
    lines.push(`- **Solution:** \`${context.solution}\``);
  }

  lines.push("");
  lines.push(
    `**Summary:** ${plan.tableCreates} table(s), ${plan.columnCreates} column(s), ${plan.lookupCreates} lookup(s) to create · ${plan.skips} already present · ${plan.conflicts} conflict(s)`,
  );
  lines.push("");
  lines.push(
    "> Additive only: existing tables and columns are never updated or deleted. To change one, delete it in Dataverse and run the plan again.",
  );
  lines.push("");

  if (plan.items.length === 0) {
    lines.push("_dataverse.schema.json declares no tables._");

    return lines.join("\n");
  }

  lines.push("```diff");

  for (const item of plan.items) {
    const symbol = actionSymbol(item.action);
    const indent = item.kind === "table" ? "" : "  ";
    const name = item.kind === "table" ? item.table : (item.column ?? "");
    const reason = item.reason == null ? "" : ` — ${item.reason}`;

    lines.push(
      `${symbol} ${indent}${kindLabel(item.kind)} ${name} — ${item.label} (${item.action}${reason})`,
    );
  }

  lines.push("```");
  lines.push("");

  if (plan.conflicts > 0) {
    lines.push(
      "**Conflicts block provisioning.** Delete the existing table or column in Dataverse, or change the schema file, then run the plan again.",
    );
  } else if (plan.tableCreates + plan.columnCreates + plan.lookupCreates === 0) {
    lines.push("**Nothing to create.** The organisation already matches the declared schema.");
  } else {
    lines.push(
      "Run `Dataverse: Provision Schema (Create Only)` to create the items marked `+`. Nothing marked `=` or `!` is touched.",
    );
  }

  return lines.join("\n");
}
