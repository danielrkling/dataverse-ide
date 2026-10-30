/*
 * TextMate grammars for JSX inside tagged template literals, vendored from
 * the "Tagged JSX Tools" VS Code extension (DanielRKling.tagged-jsx-vscode).
 *
 * Three grammars work together (see the upstream manifest):
 *  - `text.lit-jsx` (generated): injected into source.js/jsx/ts/tsx + html and
 *    matches `<tag>` + backtick for each configured tag, embedding the JSX
 *    grammar for the template content. Generated at runtime from the
 *    configurable tag list (same algorithm as the upstream extension).
 *  - `text.lit-jsx.string.injection` (vendored): highlights template
 *    substitutions inside embedded JSX tags.
 *  - `text.jsx` (vendored): the embedded JSX grammar itself, including the
 *    tagged-template flavor (`<${Component}>` dynamic tags and `<//>` close).
 *
 * The tools registration supplies the JSON as base64 data URLs via
 * registerFileUrl, so nothing needs to be fetched from disk.
 */

import litJsxStringInjectionJson from "./syntaxes/lit-jsx-string-injection.json";
import jsxJson from "./syntaxes/jsx.json";

const LIT_JSX_SCOPE_NAME = "text.lit-jsx";
const STRING_INJECTION_SCOPE = "text.lit-jsx.string.injection";
const JSX_GRAMMAR_PATH = "syntaxes/jsx.json";
const STRING_INJECTION_PATH = "syntaxes/lit-jsx-string-injection.json";

const INJECT_INTO = [
  "source.js",
  "source.js.jsx",
  "source.jsx",
  "source.ts",
  "source.tsx",
  "text.html",
];

function escapeRegexp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generates the primary injected grammar (upstream `generateLitJsxGrammar`):
 * tag patterns are built from the configured list, everything else matches
 * the reference `lit-jsx-generated.json` shape.
 */
export function generateLitJsxGrammarJson(tags: string[]): string {
  const patterns = tags.map((tag) => ({
    contentName: "meta.embedded.block.jsx",
    begin: `(?i)\\b(${escapeRegexp(tag)})(\`)`,
    beginCaptures: {
      "1": { name: "entity.name.function.tagged-template.js" },
      "2": { name: "punctuation.definition.string.template.begin.js" },
    },
    end: "`",
    endCaptures: {
      "0": { name: "punctuation.definition.string.template.end.js" },
    },
    patterns: [{ include: "source.ts#template-substitution-element" }, { include: "text.jsx" }],
  }));

  return JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
      fileTypes: [],
      injectionSelector:
        "L:source.js -comment -(string -meta.embedded), L:source.js.jsx -comment -(string -meta.embedded), L:source.jsx -comment -(string -meta.embedded), L:source.ts -comment -(string -meta.embedded), L:source.tsx -comment -(string -meta.embedded)",
      injections: {
        "L:source": {
          patterns: [
            {
              match: "<",
              name: "invalid.illegal.bad-angle-bracket.jsx",
            },
          ],
        },
      },
      patterns,
      scopeName: LIT_JSX_SCOPE_NAME,
    },
    null,
    2,
  );
}

export interface GrammarContribution {
  scopeName: string;
  path: string;
  injectTo?: string[];
  embeddedLanguages?: Record<string, string>;
}

function dataUrl(json: string | object): string {
  const text = typeof json === "string" ? json : JSON.stringify(json, null, 2);

  return `data:application/json;base64,${btoa(text)}`;
}

interface RegisteredGrammarFile {
  /** Relative path of the grammar, as referenced by `contributes.grammars`. */
  path: string;
  /** Data URL to register via registerFileUrl. */
  url: string;
}

export interface GrammarRegistrationData {
  /** `contributes.grammars` entries for the extension manifest. */
  contributions: GrammarContribution[];
  /** Files to register against the extension location. */
  files: RegisteredGrammarFile[];
  /** `contributes.languages` entry for the jsxt document language. */
  languages: object[];
}

export function buildGrammarContributions(): GrammarRegistrationData {
  return {
    contributions: [
      {
        scopeName: LIT_JSX_SCOPE_NAME,
        path: "syntaxes/lit-jsx-generated.json",
        injectTo: INJECT_INTO,
        embeddedLanguages: { "meta.embedded.block.jsx": "jsx-tagged" },
      },
      {
        scopeName: STRING_INJECTION_SCOPE,
        path: STRING_INJECTION_PATH,
        injectTo: INJECT_INTO,
        embeddedLanguages: { "meta.template.expression.ts": "typescript" },
      },
      {
        scopeName: "text.jsx",
        path: JSX_GRAMMAR_PATH,
      },
    ],
    files: [
      {
        path: JSX_GRAMMAR_PATH,
        url: dataUrl(jsxJson as unknown as object),
      },
      {
        path: STRING_INJECTION_PATH,
        url: dataUrl(litJsxStringInjectionJson as unknown as object),
      },
    ],
    languages: [
      {
        id: "jsx-tagged",
        extensions: [".jsxt"],
        aliases: ["JSX Tagged", "jsxt"],
      },
    ],
  };
}

/** Rebuilds the generated lit-jsx grammar after a tag change. */
export function regenerateLitJsx(tags: string[]): { path: string; url: string } {
  return {
    path: "syntaxes/lit-jsx-generated.json",
    url: dataUrl(generateLitJsxGrammarJson(tags)),
  };
}
