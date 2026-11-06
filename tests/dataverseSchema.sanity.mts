/*
 * Dataverse schema provisioning sanity harness.
 *
 * Run:
 *   node --experimental-strip-types tests/dataverseSchema.sanity.mts
 *
 * Covers the pure parts of the additive-only provisioner:
 *   - dataverse.schema.json parsing and name resolution
 *   - create/skip/conflict plan generation against fake metadata
 *   - the markdown diff shown by the preview command
 */

import assert from "node:assert/strict";

import {
  normalizePrefix,
  parseDataverseSchema,
  resolveDataverseSchema,
} from "../src/extensions/dataverse/schema.ts";

import {
  buildAttributeDefinition,
  buildEntityDefinition,
  buildRelationshipDefinition,
} from "../src/extensions/dataverse/metadataDefinitions.ts";

import {
  buildSchemaPlan,
  formatSchemaPlan,
  type ExistingEntityMetadata,
  type SchemaMetadataReader,
} from "../src/extensions/dataverse/schemaPlan.ts";

const schemaText = JSON.stringify({
  tables: [
    {
      name: "project",
      displayName: "Project",
      primaryName: { name: "name", displayName: "Project Name" },
      columns: [
        { name: "description", type: "memo", maxLength: 5000 },
        {
          name: "status",
          type: "choice",
          options: [{ label: "Active" }, { label: "Closed" }],
        },
        { name: "account", type: "lookup", target: "account" },
      ],
    },
  ],
});

const document = parseDataverseSchema(schemaText);

assert.deepEqual(document.tables[0]?.columns[1]?.options, [
  { label: "Active" },
  { label: "Closed" },
]);

const schema = resolveDataverseSchema(document, { prefix: "new_" });

assert.equal(schema.prefix, "new_");
assert.equal(schema.tables[0]?.logicalName, "new_project");
assert.equal(schema.tables[0]?.schemaName, "new_Project");
assert.equal(schema.tables[0]?.primaryName.logicalName, "new_name");
assert.equal(schema.tables[0]?.columns[0]?.logicalName, "new_description");
assert.equal(schema.tables[0]?.columns[1]?.options[0]?.value, 100000000);
assert.equal(schema.tables[0]?.columns[1]?.options[1]?.value, 100000001);
assert.equal(schema.tables[0]?.columns[2]?.targetLogicalName, "account");
assert.equal(schema.tables[0]?.columns[2]?.relationshipName, "new_project_new_account");

const table = schema.tables[0]!;
const entityDefinition = buildEntityDefinition(table, 1033);
const primaryNameDefinition = (entityDefinition.Attributes as Record<string, unknown>[])[0];

assert.equal(entityDefinition["@odata.type"], "Microsoft.Dynamics.CRM.EntityMetadata");
assert.equal(entityDefinition.SchemaName, "new_Project");
assert.equal(primaryNameDefinition?.IsPrimaryName, true);
assert.equal(primaryNameDefinition?.SchemaName, "new_Name");

const memoDefinition = buildAttributeDefinition(table.columns[0]!, 1033);
assert.equal(memoDefinition["@odata.type"], "Microsoft.Dynamics.CRM.MemoAttributeMetadata");
assert.equal(memoDefinition.MaxLength, 5000);

const choiceDefinition = buildAttributeDefinition(table.columns[1]!, 1033);
const choiceOptions = (choiceDefinition.OptionSet as Record<string, unknown>).Options as Record<
  string,
  unknown
>[];

assert.equal(choiceOptions[0]?.Value, 100000000);
assert.equal(choiceOptions[1]?.Value, 100000001);

const relationshipDefinition = buildRelationshipDefinition(table, table.columns[2]!, 1033);

assert.equal(relationshipDefinition.ReferencedEntity, "account");
assert.equal(relationshipDefinition.ReferencedAttribute, "accountid");
assert.equal((relationshipDefinition.Lookup as Record<string, unknown>).SchemaName, "new_Account");
assert.throws(() => buildAttributeDefinition(table.columns[2]!, 1033), /relationship API/);

assert.equal(normalizePrefix("new"), "new_");
assert.equal(normalizePrefix("new_"), "new_");

function readerFor(entity: ExistingEntityMetadata | undefined): SchemaMetadataReader {
  return {
    async getEntity(logicalName) {
      return entity?.logicalName === logicalName ? entity : undefined;
    },
  };
}

function entity(attributes: [string, string][]): ExistingEntityMetadata {
  return {
    logicalName: "new_project",
    attributes: new Map(
      attributes.map(([logicalName, attributeTypeName]) => [
        logicalName,
        { logicalName, attributeTypeName },
      ]),
    ),
  };
}

/*
 * New table: everything is created, including the primary name column that
 * is sent with the table definition.
 */
const createPlan = await buildSchemaPlan(schema, readerFor(undefined));

assert.equal(createPlan.tableCreates, 1);
assert.equal(createPlan.columnCreates, 3);
assert.equal(createPlan.lookupCreates, 1);
assert.equal(createPlan.skips, 0);
assert.equal(createPlan.conflicts, 0);
assert.deepEqual(createPlan.changedEntities, ["new_project"]);
assert.ok(createPlan.items.some((item) => item.kind === "table" && item.action === "create"));

/*
 * Existing, matching table: nothing is created.
 */
const matchingPlan = await buildSchemaPlan(
  schema,
  readerFor(
    entity([
      ["new_name", "StringType"],
      ["new_description", "MemoType"],
      ["new_status", "PicklistType"],
      ["new_account", "LookupType"],
    ]),
  ),
);

assert.equal(matchingPlan.tableCreates, 0);
assert.equal(matchingPlan.columnCreates, 0);
assert.equal(matchingPlan.lookupCreates, 0);
assert.equal(matchingPlan.skips, 5);
assert.equal(matchingPlan.conflicts, 0);

/*
 * Existing table with one missing column and one type conflict. The conflict
 * blocks provisioning; the missing column is still reported as a create.
 */
const conflictPlan = await buildSchemaPlan(
  schema,
  readerFor(
    entity([
      ["new_name", "StringType"],
      ["new_status", "StringType"],
      ["new_account", "StringType"],
    ]),
  ),
);

assert.equal(conflictPlan.tableCreates, 0);
assert.equal(conflictPlan.columnCreates, 1);
assert.equal(conflictPlan.conflicts, 2);

const formatted = formatSchemaPlan(conflictPlan, {
  apiBaseUrl: "https://example.crm.dynamics.com",
  solution: "Example",
  prefix: "new_",
});

assert.match(formatted, /Additive only/);
assert.match(formatted, /! {3}column new_status/);
assert.match(formatted, /! {3}lookup new_account/);
assert.match(formatted, /Conflicts block provisioning/);

/*
 * Invalid input must fail loudly instead of silently provisioning a partial
 * schema.
 */
assert.throws(() => parseDataverseSchema("{ not json"), /not valid JSON/);

assert.throws(
  () =>
    resolveDataverseSchema(
      parseDataverseSchema(
        JSON.stringify({
          tables: [
            {
              name: "project",
              primaryName: { name: "name" },
              columns: [
                { name: "name", type: "string" },
                { name: "name", type: "string" },
              ],
            },
          ],
        }),
      ),
      { prefix: "new_" },
    ),
  /more than once|primary name column is repeated/,
);

assert.throws(
  () =>
    resolveDataverseSchema(
      parseDataverseSchema(
        JSON.stringify({
          tables: [{ name: "project", columns: [{ name: "account", type: "lookup" }] }],
        }),
      ),
      { prefix: "new_" },
    ),
  /needs a "target"/,
);

console.log("dataverse schema: parsing, planning and diff formatting OK");
