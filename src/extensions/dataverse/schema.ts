import * as v from "valibot";

/*
 * dataverse.schema.json - the declarative, additive-only schema.
 *
 * Tables and columns are described with short names; the publisher prefix
 * (from dataverse.config.json or the optional "prefix" key here) is applied
 * when the names are sent to Dataverse. Nothing in this file can update or
 * delete an existing component: the provisioner only creates what is missing.
 */

export const DATAVERSE_SCHEMA_FILE_NAME = "dataverse.schema.json";

export const DATAVERSE_COLUMN_TYPES = [
  "string",
  "memo",
  "integer",
  "bigint",
  "decimal",
  "money",
  "boolean",
  "datetime",
  "choice",
  "multichoice",
  "lookup",
] as const;

export type DataverseColumnType = (typeof DATAVERSE_COLUMN_TYPES)[number];

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

const nameSchema = v.pipe(
  v.string(),
  v.transform((value) => value.trim()),
  v.regex(
    NAME_PATTERN,
    "Expected a name starting with a letter and containing only letters, digits, and underscores.",
  ),
);

const optionalTextSchema = v.optional(
  v.pipe(
    v.string(),
    v.transform((value) => {
      const trimmed = value.trim();

      return trimmed.length > 0 ? trimmed : undefined;
    }),
  ),
);

const optionSchema = v.strictObject({
  label: v.pipe(
    v.string(),
    v.transform((value) => value.trim()),
    v.minLength(1, "Expected a non-empty option label."),
  ),
  value: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const columnSchema = v.strictObject({
  name: nameSchema,
  type: v.picklist(DATAVERSE_COLUMN_TYPES),
  displayName: optionalTextSchema,
  description: optionalTextSchema,
  required: v.optional(v.boolean(), false),
  maxLength: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  format: optionalTextSchema,
  minValue: v.optional(v.number()),
  maxValue: v.optional(v.number()),
  precision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10))),
  trueLabel: optionalTextSchema,
  falseLabel: optionalTextSchema,
  defaultValue: v.optional(v.boolean()),
  options: v.optional(v.array(optionSchema), []),
  optionSetBase: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 100000000),
  target: optionalTextSchema,
  relationshipName: optionalTextSchema,
});

const primaryNameSchema = v.strictObject({
  name: v.optional(nameSchema, "name"),
  displayName: optionalTextSchema,
  description: optionalTextSchema,
  maxLength: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4000)), 200),
});

const tableSchema = v.strictObject({
  name: nameSchema,
  displayName: optionalTextSchema,
  displayCollectionName: optionalTextSchema,
  description: optionalTextSchema,
  ownership: v.optional(v.picklist(["UserOwned", "OrganizationOwned"] as const), "UserOwned"),
  primaryName: v.optional(primaryNameSchema, { name: "name", maxLength: 200 }),
  columns: v.optional(v.array(columnSchema), []),
});

/** Valibot schema for dataverse.schema.json. */
export const DATAVERSE_SCHEMA_SCHEMA = v.strictObject({
  prefix: optionalTextSchema,
  solution: optionalTextSchema,
  languageCode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1033),
  tables: v.optional(v.array(tableSchema), []),
});

export type DataverseSchemaDocument = v.InferOutput<typeof DATAVERSE_SCHEMA_SCHEMA>;
export type DataverseTableSpec = v.InferOutput<typeof tableSchema>;
export type DataverseColumnSpec = v.InferOutput<typeof columnSchema>;

export type ResolvedPrimaryName = {
  name: string;
  logicalName: string;
  schemaName: string;
  displayName: string;
  description?: string;
  maxLength: number;
};

export type ResolvedColumn = {
  name: string;
  logicalName: string;
  schemaName: string;
  type: DataverseColumnType;
  displayName: string;
  description?: string;
  required: boolean;
  maxLength?: number;
  format?: string;
  minValue?: number;
  maxValue?: number;
  precision?: number;
  trueLabel?: string;
  falseLabel?: string;
  defaultValue?: boolean;
  options: { label: string; value: number }[];
  target?: string;
  targetLogicalName?: string;
  relationshipName?: string;
};

export type ResolvedTable = {
  name: string;
  logicalName: string;
  schemaName: string;
  displayName: string;
  displayCollectionName: string;
  description?: string;
  ownership: "UserOwned" | "OrganizationOwned";
  primaryName: ResolvedPrimaryName;
  columns: ResolvedColumn[];
};

export type ResolvedSchema = {
  prefix: string;
  solution?: string;
  languageCode: number;
  tables: ResolvedTable[];
};

function humanize(value: string): string {
  const words = value
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();

  return words.replace(/\b\w/g, (character) => character.toUpperCase());
}

function stripPrefix(name: string, prefix: string): string {
  const trimmed = name.trim();

  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed.slice(prefix.length);
  }

  return trimmed;
}

function toSchemaName(prefix: string, shortName: string): string {
  return `${prefix}${shortName.charAt(0).toUpperCase()}${shortName.slice(1)}`;
}

/**
 * Normalize a publisher prefix to its customization form (`new` and `new_`
 * both become `new_`). The web resource prefix and the publisher prefix are
 * not always the same, so dataverse.schema.json may override the value from
 * dataverse.config.json.
 */
export function normalizePrefix(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(
      'Set "prefix" in dataverse.schema.json (or dataverse.config.json) to the Dataverse publisher prefix, for example "new_".',
    );
  }

  const prefix = trimmed.endsWith("_") ? trimmed : `${trimmed}_`;

  if (!/^[A-Za-z][A-Za-z0-9]{1,7}_$/.test(prefix)) {
    throw new Error(
      `"${value}" is not a valid Dataverse publisher prefix. Use the publisher's customization prefix, for example "new_" (2-8 letters or digits, ending with an underscore).`,
    );
  }

  return prefix;
}

/** Parse and validate the schema file. Unlike the other config readers this throws on invalid input. */
export function parseDataverseSchema(text: string): DataverseSchemaDocument {
  let json: unknown;

  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `dataverse.schema.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = v.safeParse(DATAVERSE_SCHEMA_SCHEMA, json);

  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = (issue.path ?? [])
          .map((item) => (item as { key?: string | number }).key)
          .filter((key) => key != null)
          .join(".");

        return `- ${path.length > 0 ? path : "(root)"}: ${issue.message}`;
      })
      .join("\n");

    throw new Error(`dataverse.schema.json is invalid:\n${issues}`);
  }

  return result.output;
}

function resolveOptions(column: DataverseColumnSpec): { label: string; value: number }[] {
  const base = column.optionSetBase ?? 100000000;
  const seen = new Set<number>();

  return column.options.map((option, index) => {
    const value = option.value ?? base + index;

    if (seen.has(value)) {
      throw new Error(
        `Choice column "${column.name}" reuses option value ${value}. Give every option a unique value.`,
      );
    }

    seen.add(value);

    return { label: option.label.trim(), value };
  });
}

function resolveColumn(column: DataverseColumnSpec, prefix: string): ResolvedColumn {
  const shortName = stripPrefix(column.name, prefix);

  if (shortName.length === 0) {
    throw new Error(`Column "${column.name}" is only the publisher prefix.`);
  }

  const logicalName = `${prefix}${shortName}`.toLowerCase();
  const schemaName = toSchemaName(prefix, shortName);
  const displayName = column.displayName ?? humanize(shortName);
  const required = column.required === true;

  let maxLength = column.maxLength;
  let precision = column.precision;
  let format = column.format;

  switch (column.type) {
    case "string":
      maxLength ??= 200;

      if (maxLength > 4000) {
        throw new Error(
          `String column "${column.name}" has maxLength ${maxLength}; the limit is 4000.`,
        );
      }

      format ??= "Text";
      break;

    case "memo":
      maxLength ??= 2000;

      if (maxLength > 1048576) {
        throw new Error(
          `Memo column "${column.name}" has maxLength ${maxLength}; the limit is 1048576.`,
        );
      }

      format ??= "TextArea";
      break;

    case "decimal":
      precision ??= 2;

      if (precision > 10) {
        throw new Error(
          `Decimal column "${column.name}" has precision ${precision}; the limit is 10.`,
        );
      }

      break;

    case "money":
      /*
       * Leave precision unset by default: Dataverse then follows the
       * transaction currency's precision (PrecisionSource = 2). An explicit
       * precision switches to PrecisionSource = 0.
       */
      break;

    case "datetime":
      format ??= "DateOnly";
      break;

    case "choice":
    case "multichoice":
      if (column.options.length === 0) {
        throw new Error(`Choice column "${column.name}" needs at least one option.`);
      }

      break;

    case "lookup":
      if (column.target == null || column.target.length === 0) {
        throw new Error(`Lookup column "${column.name}" needs a "target" table.`);
      }

      break;
  }

  if (column.minValue != null && column.maxValue != null && column.minValue > column.maxValue) {
    throw new Error(`Column "${column.name}" has minValue greater than maxValue.`);
  }

  return {
    name: shortName,
    logicalName,
    schemaName,
    type: column.type,
    displayName,
    description: column.description,
    required,
    maxLength,
    format,
    minValue: column.minValue,
    maxValue: column.maxValue,
    precision,
    trueLabel: column.trueLabel,
    falseLabel: column.falseLabel,
    defaultValue: column.defaultValue,
    options: resolveOptions(column),
    target: column.target,
    relationshipName: column.relationshipName,
  };
}

function resolveTable(table: DataverseTableSpec, prefix: string): ResolvedTable {
  const shortTableName = stripPrefix(table.name, prefix);

  if (shortTableName.length === 0) {
    throw new Error(`Table "${table.name}" is only the publisher prefix.`);
  }

  const logicalName = `${prefix}${shortTableName}`.toLowerCase();
  const schemaName = toSchemaName(prefix, shortTableName);
  const primaryShortName = stripPrefix(table.primaryName.name, prefix);

  if (primaryShortName.length === 0) {
    throw new Error(`Table "${table.name}" has an invalid primary name column.`);
  }

  const primaryLogicalName = `${prefix}${primaryShortName}`.toLowerCase();

  if (primaryLogicalName === logicalName) {
    throw new Error(
      `Table "${table.name}" cannot use "${table.primaryName.name}" as its primary name column; choose a different name.`,
    );
  }

  const displayName = table.displayName ?? humanize(shortTableName);
  const columns: ResolvedColumn[] = [];
  const usedNames = new Set<string>([primaryLogicalName]);

  for (const column of table.columns) {
    const resolved = resolveColumn(column, prefix);

    if (usedNames.has(resolved.logicalName)) {
      throw new Error(
        `Table "${table.name}" declares the column "${resolved.logicalName}" more than once (or the primary name column is repeated).`,
      );
    }

    usedNames.add(resolved.logicalName);

    if (resolved.relationshipName != null && resolved.relationshipName.length > 100) {
      throw new Error(
        `Lookup column "${column.name}" has a relationship name longer than 100 characters.`,
      );
    }

    columns.push(resolved);
  }

  return {
    name: shortTableName,
    logicalName,
    schemaName,
    displayName,
    displayCollectionName: table.displayCollectionName ?? `${displayName}s`,
    description: table.description,
    ownership: table.ownership,
    primaryName: {
      name: primaryShortName,
      logicalName: primaryLogicalName,
      schemaName: toSchemaName(prefix, primaryShortName),
      displayName: table.primaryName.displayName ?? humanize(primaryShortName),
      description: table.primaryName.description,
      maxLength: table.primaryName.maxLength,
    },
    columns,
  };
}

/**
 * Resolve short names to Dataverse logical/schema names and link lookups to
 * tables declared in the same file. `options.prefix` wins over the file's own
 * prefix; callers pass the value from dataverse.config.json.
 */
export function resolveDataverseSchema(
  document: DataverseSchemaDocument,
  options: { prefix?: string; solution?: string } = {},
): ResolvedSchema {
  const prefix = normalizePrefix(options.prefix?.trim() || document.prefix || "");
  const solution = options.solution?.trim() || document.solution?.trim() || undefined;
  const tables = document.tables.map((table) => resolveTable(table, prefix));

  const seenTables = new Set<string>();

  for (const table of tables) {
    if (seenTables.has(table.logicalName)) {
      throw new Error(`Table "${table.logicalName}" is declared more than once.`);
    }

    seenTables.add(table.logicalName);
  }

  const byShortName = new Map(tables.map((table) => [table.name.toLowerCase(), table] as const));

  for (const table of tables) {
    for (const column of table.columns) {
      if (column.type !== "lookup") {
        continue;
      }

      const target = (column.target ?? "").trim().toLowerCase();
      const declared =
        byShortName.get(target) ?? tables.find((table) => table.logicalName === target);

      if (declared == null && !/^[a-z][a-z0-9_]*$/.test(target)) {
        throw new Error(
          `Lookup column "${column.name}" targets "${column.target}", which is not a declared table and is not a valid logical name.`,
        );
      }

      column.targetLogicalName = declared?.logicalName ?? target;
    }
  }

  for (const table of tables) {
    for (const column of table.columns) {
      if (column.type !== "lookup") {
        continue;
      }

      const relationshipName =
        column.relationshipName?.trim() || `${table.logicalName}_${column.logicalName}`;

      if (!relationshipName.toLowerCase().startsWith(prefix.toLowerCase())) {
        throw new Error(
          `Lookup column "${column.name}" relationshipName "${relationshipName}" must start with the publisher prefix "${prefix}".`,
        );
      }

      if (relationshipName.length > 100) {
        throw new Error(
          `Lookup column "${column.name}" creates a relationship name longer than 100 characters. Set "relationshipName" to a shorter value.`,
        );
      }

      column.relationshipName = relationshipName;
    }
  }

  return {
    prefix,
    solution,
    languageCode: document.languageCode,
    tables,
  };
}

/** Workspace-relative path of the schema file setting default. */
export const DATAVERSE_SCHEMA_PATH_SETTING = "schemaPath";
