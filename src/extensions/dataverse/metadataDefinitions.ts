import type { ResolvedColumn, ResolvedTable } from "./schema.js";

/*
 * Dataverse metadata payload builders.
 *
 * These are deliberately plain object builders so the exact JSON sent to the
 * Web API can be reviewed in one place. The shapes follow the Web API
 * metadata reference:
 *   POST /EntityDefinitions
 *   POST /EntityDefinitions(LogicalName='…')/Attributes
 *   POST /RelationshipDefinitions
 */

type JsonObject = Record<string, unknown>;

function localizedLabel(text: string, languageCode: number): JsonObject {
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
    Label: text,
    LanguageCode: languageCode,
  };
}

function label(text: string | undefined, languageCode: number): JsonObject | undefined {
  if (text == null || text.trim().length === 0) {
    return undefined;
  }

  return {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    LocalizedLabels: [localizedLabel(text, languageCode)],
  };
}

function requiredLevel(required: boolean): JsonObject {
  return {
    Value: required ? "ApplicationRequired" : "None",
    CanBeChanged: true,
    ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings",
  };
}

function optionSetOptions(column: ResolvedColumn, languageCode: number): JsonObject[] {
  return column.options.map((option) => ({
    Value: option.value,
    Label: label(option.label, languageCode),
  }));
}

export function buildPrimaryNameAttribute(table: ResolvedTable, languageCode: number): JsonObject {
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    AttributeType: "String",
    AttributeTypeName: { Value: "StringType" },
    SchemaName: table.primaryName.schemaName,
    DisplayName: label(table.primaryName.displayName, languageCode),
    Description: label(table.primaryName.description, languageCode),
    IsPrimaryName: true,
    RequiredLevel: requiredLevel(false),
    FormatName: { Value: "Text" },
    MaxLength: table.primaryName.maxLength,
    AutoNumberFormat: table.primaryName.autoNumberFormat,
  };
}

export function buildEntityDefinition(table: ResolvedTable, languageCode: number): JsonObject {
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
    SchemaName: table.schemaName,
    DisplayName: label(table.displayName, languageCode),
    DisplayCollectionName: label(table.displayCollectionName, languageCode),
    Description: label(table.description, languageCode),
    OwnershipType: table.ownership,
    IsActivity: false,
    HasActivities: false,
    HasNotes: false,
    Attributes: [buildPrimaryNameAttribute(table, languageCode)],
  };
}

export function buildAttributeDefinition(column: ResolvedColumn, languageCode: number): JsonObject {
  const base: JsonObject = {
    SchemaName: column.schemaName,
    DisplayName: label(column.displayName, languageCode),
    Description: label(column.description, languageCode),
    RequiredLevel: requiredLevel(column.required),
  };

  switch (column.type) {
    case "string":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        AttributeType: "String",
        AttributeTypeName: { Value: "StringType" },
        FormatName: { Value: column.format ?? "Text" },
        MaxLength: column.maxLength ?? 200,
        AutoNumberFormat: column.autoNumberFormat,
      };

    case "memo":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
        AttributeType: "Memo",
        AttributeTypeName: { Value: "MemoType" },
        Format: column.format ?? "TextArea",
        ImeMode: "Disabled",
        IsLocalizable: false,
        MaxLength: column.maxLength ?? 2000,
      };

    case "integer":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
        AttributeType: "Integer",
        AttributeTypeName: { Value: "IntegerType" },
        Format: "None",
        MinValue: column.minValue,
        MaxValue: column.maxValue,
      };

    case "bigint":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.BigIntAttributeMetadata",
        AttributeType: "BigInt",
        AttributeTypeName: { Value: "BigIntType" },
      };

    case "decimal":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
        AttributeType: "Decimal",
        AttributeTypeName: { Value: "DecimalType" },
        Precision: column.precision ?? 2,
        MinValue: column.minValue,
        MaxValue: column.maxValue,
      };

    case "money":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
        AttributeType: "Money",
        AttributeTypeName: { Value: "MoneyType" },
        ...(column.precision == null
          ? { PrecisionSource: 2 }
          : { PrecisionSource: 0, Precision: column.precision }),
      };

    case "boolean":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
        AttributeType: "Boolean",
        AttributeTypeName: { Value: "BooleanType" },
        DefaultValue: column.defaultValue ?? false,
        OptionSet: {
          OptionSetType: "Boolean",
          TrueOption: {
            Value: 1,
            Label: label(column.trueLabel ?? "True", languageCode),
          },
          FalseOption: {
            Value: 0,
            Label: label(column.falseLabel ?? "False", languageCode),
          },
        },
      };

    case "datetime":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
        AttributeType: "DateTime",
        AttributeTypeName: { Value: "DateTimeType" },
        Format: column.format ?? "DateOnly",
      };

    case "choice":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
        AttributeType: "Picklist",
        AttributeTypeName: { Value: "PicklistType" },
        OptionSet: {
          "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
          IsGlobal: false,
          OptionSetType: "Picklist",
          Options: optionSetOptions(column, languageCode),
        },
      };

    case "multichoice":
      return {
        ...base,
        "@odata.type": "Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata",
        AttributeType: "Virtual",
        AttributeTypeName: { Value: "MultiSelectPicklistType" },
        OptionSet: {
          "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
          IsGlobal: false,
          OptionSetType: "Picklist",
          Options: optionSetOptions(column, languageCode),
        },
      };

    case "lookup":
      throw new Error(
        `Lookup column "${column.logicalName}" must be created through the relationship API, not the attribute API.`,
      );
  }
}

export function buildRelationshipDefinition(
  table: ResolvedTable,
  column: ResolvedColumn,
  languageCode: number,
): JsonObject {
  if (column.targetLogicalName == null) {
    throw new Error(`Lookup column "${column.logicalName}" has no resolved target table.`);
  }

  return {
    "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    SchemaName: column.relationshipName ?? `${table.logicalName}_${column.logicalName}`,
    ReferencedEntity: column.targetLogicalName,
    ReferencedAttribute: `${column.targetLogicalName}id`,
    ReferencingEntity: table.logicalName,
    Lookup: {
      "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
      AttributeType: "Lookup",
      AttributeTypeName: { Value: "LookupType" },
      SchemaName: column.schemaName,
      DisplayName: label(column.displayName, languageCode),
      Description: label(column.description, languageCode),
      RequiredLevel: requiredLevel(column.required),
    },
  };
}
