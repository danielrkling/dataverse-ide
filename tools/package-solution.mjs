#!/usr/bin/env node
/*
 * Packages dist/ as an unmanaged Dataverse solution (.zip) containing the IDE
 * as plain web resources - no model-driven app, sitemap, or other components.
 *
 * A solution zip is an OpenXML package with three metadata files plus the
 * component files:
 *
 *   [Content_Types].xml
 *   solution.xml        SolutionManifest (publisher, version, root components)
 *   customizations.xml  <WebResources> entries pointing at the files below
 *   WebResources/<web resource name>            e.g. WebResources/dv_ide/index.html
 *
 * The web resource name mirrors the file's path under dist/, prefixed with
 * --prefix (default "dv_ide"), so dist/assets/index-abc.js is published as
 * "dv_ide/assets/index-abc.js" - the same names tools/deploy-webresources.ps1
 * uploads.
 *
 * The zip is always unmanaged. Dataverse only produces managed solutions by
 * exporting an unmanaged solution from an org, so that step can't happen here.
 *
 * Usage:
 *   npm run build
 *   node tools/package-solution.mjs
 *   node tools/package-solution.mjs --solution=DataverseIDE --version=1.2.0.0
 *   node tools/package-solution.mjs --prefix=dv_ide --out=artifacts/ide.zip
 *
 * Everything is reproducible: entries are sorted and use a fixed timestamp,
 * and WebResourceId values are derived from the web resource name.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const DEFAULT_MAX_WEB_RESOURCE_BYTES = 5 * 1024 * 1024;

/*
 * WebResource.OptionSetType values. Keep in sync with
 * src/extensions/dataverse/webResourceClient.ts.
 */
const WEB_RESOURCE_TYPES = {
  html: 1,
  htm: 1,
  css: 2,
  js: 3,
  mjs: 3,
  json: 3,
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
};

/*
 * .map files are devtools-only and not a web resource type. The PWA manifest
 * is generated in memory by public/pwa.js (Dataverse has no .webmanifest
 * type), so the copy copied from public/ is intentionally not packaged.
 */
const SKIPPED_EXTENSIONS = new Set(["map", "webmanifest", "zip"]);

const args = new Map();

for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);

  if (match != null) {
    args.set(match[1], match[2] ?? "true");
  }
}

if (args.has("help")) {
  console.log(
    [
      "Usage: node tools/package-solution.mjs [options]",
      "",
      "  --dist=<dir>               Build output to package (default: dist)",
      "  --out=<file>               Output zip (default: artifacts/<solution>_<version>.zip)",
      "  --prefix=<name>            Web resource name prefix (default: dv_ide)",
      "  --solution=<unique name>   Solution unique name (default: DataverseIDE)",
      "  --display-name=<text>      Solution display name (default: Dataverse IDE)",
      "  --description=<text>       Solution description",
      "  --publisher=<unique name>  Publisher unique name (default: same as solution)",
      "  --publisher-prefix=<text>  Publisher customization prefix (default: dv)",
      "  --version=<a.b.c.d>        Solution version (default: 1.0.0.0)",
      "  --language=<lcid>          Language code (default: 1033)",
    ].join("\n"),
  );
  process.exit(0);
}

const distDir = path.resolve(args.get("dist") ?? "dist");
const prefix = (args.get("prefix") ?? "dv_ide").replace(/^\/+|\/+$/g, "");
const solutionName = args.get("solution") ?? "DataverseIDE";
const displayName = args.get("display-name") ?? "Dataverse IDE";
const description =
  args.get("description") ?? "Dataverse IDE browser IDE, deployed as Dataverse web resources.";
const publisherName = args.get("publisher") ?? solutionName;
const publisherPrefix = args.get("publisher-prefix") ?? "dv";
const version = args.get("version") ?? "1.0.0.0";
const languageCode = Number(args.get("language") ?? 1033);
const outPath = path.resolve(
  args.get("out") ?? path.join("artifacts", `${solutionName}_${version}.zip`),
);

/*
 * Fixed DOS timestamp (2020-01-01 00:00) so repeated builds produce identical
 * zips; the solution version, not the file mtime, identifies the build.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let value = n;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[n] = value >>> 0;
  }

  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (stored/deflate) - avoids adding a dependency for one script. */
function createZip(entries) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by (MS-DOS)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 file names
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset

    centralDirectory.push(Buffer.concat([central, nameBytes]));

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralDirectory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central directory start disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuffer, end]);
}

function escapeXml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character],
  );
}

/** Deterministic UUID (v5-shaped) from the web resource name. */
function stableGuid(name) {
  const bytes = Buffer.from(
    createHash("sha1").update(`dataverse-ide:${name}`).digest().subarray(0, 16),
  );

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

async function collectFiles(root) {
  const files = [];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && !entry.name.startsWith(".")) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);

  return files;
}

function buildSolutionXml(webResources) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="${languageCode}" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${escapeXml(solutionName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${escapeXml(displayName)}" languagecode="${languageCode}" />
    </LocalizedNames>
    <Descriptions>
      <Description description="${escapeXml(description)}" languagecode="${languageCode}" />
    </Descriptions>
    <Version>${version}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${escapeXml(publisherName)}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${escapeXml(publisherName)}" languagecode="${languageCode}" />
      </LocalizedNames>
      <Descriptions>
        <Description description="${escapeXml(publisherName)}" languagecode="${languageCode}" />
      </Descriptions>
      <DefaultPrefix>${escapeXml(publisherPrefix)}</DefaultPrefix>
      <EMailAddress xsi:nil="true" />
      <SupportingWebsiteUrl xsi:nil="true" />
      <CustomizationPrefix>${escapeXml(publisherPrefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix>
      <Addresses>
        <Address>
          <AddressNumber>1</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
        </Address>
      </Addresses>
    </Publisher>
    <RootComponents>
${webResources
  .map(
    (resource) =>
      `      <RootComponent type="61" schemaName="${escapeXml(resource.name)}" behavior="0" />`,
  )
  .join("\n")}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
`;
}

function buildCustomizationsXml(webResources) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" OrganizationSchemaType="Standard" CRMServerServiceabilityVersion="9.2.0.0">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <SolutionPluginAssemblies />
  <WebResources>
${webResources
  .map(
    (resource) => `    <WebResource>
      <WebResourceId>${resource.webResourceId}</WebResourceId>
      <Name>${escapeXml(resource.name)}</Name>
      <DisplayName>${escapeXml(resource.displayName)}</DisplayName>
      <Description>${escapeXml(description)}</Description>
      <WebResourceType>${resource.type}</WebResourceType>
      <IsCustomizable>1</IsCustomizable>
      <CanBeDeleted>1</CanBeDeleted>
      <IsHidden>0</IsHidden>
      <FileName>/WebResources/${escapeXml(resource.name)}</FileName>
      <IsManaged>0</IsManaged>
      <IntroducedVersion>${version}</IntroducedVersion>
      <Dependencies />
    </WebResource>`,
  )
  .join("\n")}
  </WebResources>
</ImportExportXml>
`;
}

function buildContentTypesXml(extensions) {
  const defaults = [...new Set(["xml", ...extensions])].sort();

  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults
  .map(
    (extension) =>
      `  <Default Extension="${escapeXml(extension)}" ContentType="application/octet-stream" />`,
  )
  .join("\n")}
</Types>
`;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    fail(`--version must be in major.minor.build.revision form, got "${version}"`);
  }

  if (!/^[a-z][a-z0-9]*$/.test(publisherPrefix)) {
    fail(`--publisher-prefix must be lowercase letters/digits, got "${publisherPrefix}"`);
  }

  if (!prefix.startsWith(`${publisherPrefix}_`)) {
    fail(
      `--prefix "${prefix}" must start with the publisher prefix "${publisherPrefix}_" (web resource names must carry the publisher prefix).`,
    );
  }

  let distEntries;

  try {
    distEntries = await fs.readdir(distDir, { withFileTypes: true });
  } catch {
    fail(`dist folder not found: ${distDir} (run "npm run build" first)`);
  }

  if (!distEntries.some((entry) => entry.isFile() && entry.name === "index.html")) {
    fail(`dist folder has no index.html: ${distDir} (run "npm run build" first)`);
  }

  const files = await collectFiles(distDir);
  const webResources = [];
  const skipped = [];
  const unsupported = [];

  for (const file of files) {
    const relativePath = path.relative(distDir, file).split(path.sep).join("/");
    const extension = path.extname(file).slice(1).toLowerCase();

    if (SKIPPED_EXTENSIONS.has(extension)) {
      skipped.push(relativePath);

      continue;
    }

    const type = WEB_RESOURCE_TYPES[extension];

    if (type == null) {
      unsupported.push(relativePath);

      continue;
    }

    const name = `${prefix}/${relativePath}`;

    if (/[^A-Za-z0-9_./-]/.test(name)) {
      fail(
        `web resource name "${name}" contains characters Dataverse does not allow (use only letters, digits, _, ., / and -)`,
      );
    }

    webResources.push({
      name,
      displayName: relativePath,
      type,
      webResourceId: `{${stableGuid(name)}}`,
      file,
      size: (await fs.stat(file)).size,
      zipPath: `WebResources/${name}`,
    });
  }

  if (unsupported.length > 0) {
    fail(
      `unsupported file extension(s) in ${distDir}:\n${unsupported
        .map((file) => `  ${file}`)
        .join("\n")}\nAdd them to WEB_RESOURCE_TYPES or SKIPPED_EXTENSIONS.`,
    );
  }

  if (webResources.length === 0) {
    fail(`no web resources found in ${distDir}`);
  }

  const totalBytes = webResources.reduce((sum, resource) => sum + resource.size, 0);
  const oversized = webResources.filter(
    (resource) => resource.size > DEFAULT_MAX_WEB_RESOURCE_BYTES,
  );

  const zipEntries = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        buildContentTypesXml(
          webResources.map((resource) => path.extname(resource.file).slice(1).toLowerCase()),
        ),
      ),
    },
    { name: "solution.xml", data: Buffer.from(buildSolutionXml(webResources)) },
    { name: "customizations.xml", data: Buffer.from(buildCustomizationsXml(webResources)) },
  ];

  for (const resource of webResources) {
    zipEntries.push({ name: resource.zipPath, data: await fs.readFile(resource.file) });
  }

  const zip = createZip(zipEntries);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, zip);

  console.log(`Solution:  ${solutionName} ${version} (unmanaged)`);
  console.log(`Publisher: ${publisherName} (prefix ${publisherPrefix})`);
  console.log(`Resources: ${webResources.length} files, ${formatBytes(totalBytes)} uncompressed`);
  console.log(`Zip:       ${outPath} (${formatBytes(zip.length)})`);

  if (skipped.length > 0) {
    console.log(`Skipped:   ${skipped.length} file(s): ${skipped.join(", ")}`);
  }

  if (oversized.length > 0) {
    console.warn("");
    console.warn(
      `warning: ${oversized.length} web resource(s) exceed Dataverse's default 5 MiB limit.`,
    );
    console.warn(
      "Raise System Settings -> Email -> 'Set file size limit for attachments' (Organization.MaxUploadFileSize)",
    );
    console.warn("in the target org before importing, or the import will fail:");

    for (const resource of oversized.sort((left, right) => right.size - left.size)) {
      console.warn(`  ${formatBytes(resource.size).padStart(9)}  ${resource.name}`);
    }
  }

  console.log("");
  console.log("Import with Power Platform admin center -> Solutions -> Import solution,");
  console.log("or the Web API ImportSolution action.");
}

await main();
