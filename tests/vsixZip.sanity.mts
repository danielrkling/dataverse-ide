/*
 * Sanity checks for the VSIX ZIP reader.
 *
 * Builds stored and deflate-compressed archives in memory, then verifies
 * paths/contents, CRC-free parsing, traversal rejection and corrupt input.
 *
 * Run: node --experimental-strip-types tests/vsixZip.sanity.mts
 */
import { strict as assert } from "node:assert";

import { normalizeZipPath, unzip } from "../src/extensions/vsix/zip.ts";

type Entry = { path: string; content?: Uint8Array; compress?: boolean };

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const copy = data.slice();
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new CompressionStream("deflate-raw"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

function u16(value: number): Uint8Array {
  const buffer = new Uint8Array(2);
  new DataView(buffer.buffer).setUint16(0, value, true);
  return buffer;
}

function u32(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  new DataView(buffer.buffer).setUint32(0, value, true);
  return buffer;
}

async function buildZip(entries: Entry[]): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8(entry.path);
    const content = entry.content ?? new Uint8Array(0);
    const compressed = entry.compress ? await deflateRaw(content) : content;
    const method = entry.compress ? 8 : 0;

    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(method),
      u32(0),
      u32(0),
      u32(compressed.byteLength),
      u32(content.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      compressed,
    ]);

    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x800),
      u16(method),
      u32(0),
      u32(0),
      u32(compressed.byteLength),
      u32(content.byteLength),
      u16(name.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);

    localParts.push(local);
    centralParts.push(central);
    offset += local.byteLength;
  }

  const centralDirectory = concat(centralParts);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.byteLength),
    u32(offset),
    u16(0),
  ]);

  return concat([...localParts, centralDirectory, end]);
}

const packageJson = utf8(
  JSON.stringify({
    name: "fixture-extension",
    publisher: "fixture",
    version: "1.2.3",
    engines: { vscode: "*" },
    browser: "dist/extension.js",
  }),
);

const archive = await buildZip([
  { path: "extension/package.json", content: packageJson, compress: true },
  {
    path: "extension/dist/extension.js",
    content: utf8("exports.activate = () => {}"),
    compress: true,
  },
  { path: "extension/README.md", content: utf8("# Fixture"), compress: false },
  { path: "extension.vsixmanifest", content: utf8("<xml/>"), compress: false },
  { path: "extension/assets/", content: undefined, compress: false },
]);

const entries = await unzip(archive);
const byPath = new Map(entries.map((entry) => [entry.path, entry]));

assert.equal(byPath.get("extension/package.json")?.content?.byteLength, packageJson.byteLength);
assert.equal(
  new TextDecoder().decode(byPath.get("extension/package.json")!.content!),
  new TextDecoder().decode(packageJson),
);
assert.equal(
  new TextDecoder().decode(byPath.get("extension/dist/extension.js")!.content!),
  "exports.activate = () => {}",
);
assert.equal(new TextDecoder().decode(byPath.get("extension/README.md")!.content!), "# Fixture");
assert.equal(byPath.get("extension/assets/")?.directory, true);
assert.equal(byPath.get("extension/assets/")?.content, undefined);

console.log(`zip reader: parsed ${entries.length} entries (stored + deflate) OK`);

// Path normalization / traversal.
assert.equal(normalizeZipPath("./extension//dist/extension.js"), "extension/dist/extension.js");
assert.throws(() => normalizeZipPath("extension/../../escape.js"), /Unsafe path/);
assert.throws(() => normalizeZipPath("extension/dist/../dist/extension.js"), /Unsafe path/);

// Corrupt archive (truncated / missing EOCD).
assert.throws(() => normalizeZipPath(".."), /Unsafe path/);
await assert.rejects(unzip(new Uint8Array(10)), /too small/);
await assert.rejects(unzip(new Uint8Array(30)), /end of central directory/);

console.log("zip reader: path and corrupt-archive checks OK");
