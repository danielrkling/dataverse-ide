/*
 * Module transpilation for the direct-fs runtime.
 *
 * TypeScript/JSX/ESM sources are lowered to CommonJS with the same
 * esbuild-wasm instance the bundlers use. Plain JavaScript is still run
 * through the transform so `import`/`export` and `import.meta` become
 * CommonJS-compatible.
 */

const REQUIRE_CALL = /(?:^|[^\w$.])require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const DYNAMIC_IMPORT_CALL = /(?:^|[^\w$.])__dynamicImport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function skipQuoted(code: string, start: number, quote: string): number {
  let index = start + 1;

  while (index < code.length) {
    const char = code[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === quote) {
      return index + 1;
    }

    index += 1;
  }

  return code.length;
}

function skipLineComment(code: string, start: number): number {
  const end = code.indexOf("\n", start);

  return end < 0 ? code.length : end;
}

function skipBlockComment(code: string, start: number): number {
  const end = code.indexOf("*/", start + 2);

  return end < 0 ? code.length : end + 2;
}

function readTemplateExpression(code: string, start: number): { text: string; end: number } {
  let index = start;
  let depth = 1;

  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];

    if (char === "/" && next === "/") {
      index = skipLineComment(code, index);
      continue;
    }

    if (char === "/" && next === "*") {
      index = skipBlockComment(code, index);
      continue;
    }

    if (char === '"' || char === "'") {
      index = skipQuoted(code, index, char);
      continue;
    }

    if (char === "`") {
      index = rewriteTemplate(code, index).end;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return { text: code.slice(start, index), end: index + 1 };
      }
    }

    index += 1;
  }

  return { text: code.slice(start), end: code.length };
}

function rewriteTemplate(code: string, start: number): { text: string; end: number } {
  let text = "`";
  let index = start + 1;

  while (index < code.length) {
    const char = code[index];

    if (char === "\\") {
      text += code.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char === "`") {
      text += "`";

      return { text, end: index + 1 };
    }

    if (char === "$" && code[index + 1] === "{") {
      const expression = readTemplateExpression(code, index + 2);

      text += "${" + rewriteDynamicImports(expression.text) + "}";
      index = expression.end;
      continue;
    }

    text += char;
    index += 1;
  }

  return { text, end: index };
}

/*
 * Rewrite dynamic `import(...)` calls into `__dynamicImport(...)` without
 * touching strings, comments or template literal text.
 *
 * The previous regex matched `import(` inside string literals. Prettier's
 * bin uses `new Function("module", "return import(module)")` to obtain a
 * native dynamic import, and rewriting that string broke the generated
 * function (`__dynamicImport is not defined` at runtime).
 */
export function rewriteDynamicImports(code: string): string {
  let output = "";
  let index = 0;
  let previousSignificant = "";

  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];

    if (char === "/" && next === "/") {
      const end = skipLineComment(code, index);

      output += code.slice(index, end);
      index = end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = skipBlockComment(code, index);

      output += code.slice(index, end);
      index = end;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = skipQuoted(code, index, char);

      output += code.slice(index, end);
      index = end;
      previousSignificant = char;
      continue;
    }

    if (char === "`") {
      const template = rewriteTemplate(code, index);

      output += template.text;
      index = template.end;
      previousSignificant = "`";
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = index + 1;

      while (end < code.length && isIdentifierPart(code[end])) {
        end += 1;
      }

      const word = code.slice(index, end);

      if (word === "import" && previousSignificant !== "." && previousSignificant !== "$") {
        let lookahead = end;

        while (lookahead < code.length && isWhitespace(code[lookahead])) {
          lookahead += 1;
        }

        if (code[lookahead] === "(") {
          output += "__dynamicImport";
          index = end;
          previousSignificant = "t";
          continue;
        }
      }

      output += word;
      index = end;
      previousSignificant = word[word.length - 1] ?? "";
      continue;
    }

    output += char;

    if (!isWhitespace(char)) {
      previousSignificant = char;
    }

    index += 1;
  }

  return output;
}

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
    /*
     * esbuild leaves import() alone in cjs output unless dynamic import is
     * marked unsupported. Lowering it to require() lets the loader prefetch
     * literal specifiers and reuse the retry/hydration path. A regex rewrite
     * was fragile: it could desynchronize on quoted code in large bundles.
     */
    supported: {
      "dynamic-import": false,
    },
  });

  return result.code;
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
