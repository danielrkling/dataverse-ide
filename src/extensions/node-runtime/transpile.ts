/*
 * Module transpilation for the direct-fs runtime.
 *
 * TypeScript/JSX/ESM sources are lowered to CommonJS with the same
 * esbuild-wasm instance the bundlers use. Plain JavaScript is still run
 * through the transform so `import`/`export` and `import.meta` become
 * CommonJS-compatible.
 */

const DYNAMIC_IMPORT = /(?<![.$\w])import\s*\(/g;
const REQUIRE_CALL = /(?:^|[^\w$.])require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const DYNAMIC_IMPORT_CALL = /(?:^|[^\w$.])__dynamicImport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

export async function transpileModule(path: string, source: string): Promise<string> {
  let code = source;

  if (code.startsWith("#!")) {
    const newline = code.indexOf("\n");
    code = newline < 0 ? "" : code.slice(newline + 1);
  }

  const { transformForBundler } = await import("../esbuild/compiler.js");

  const result = await transformForBundler({
    filename: path,
    source: code,
    format: "cjs",
    define: {
      "import.meta": "__importMeta",
    },
  });

  /*
   * esbuild leaves dynamic import() alone in cjs output. Route it through
   * the runtime so it can resolve workspace modules asynchronously.
   */
  return result.code.replace(DYNAMIC_IMPORT, "__dynamicImport(");
}

export function collectModuleSpecifiers(code: string): string[] {
  const specifiers = new Set<string>();

  for (const pattern of [REQUIRE_CALL, DYNAMIC_IMPORT_CALL]) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(code)) != null) {
      specifiers.add(match[2]);
    }
  }

  return [...specifiers];
}
