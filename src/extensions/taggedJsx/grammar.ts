/*
 * TextMate injection grammar for JSX inside tagged template literals.
 *
 * Modeled on the "Tagged JSX Tools" VS Code extension: an injection grammar is
 * generated from the configured tag list (html, jsx, ...) and injected into the
 * JavaScript / TypeScript grammars. Once the injector matches `<tag> + backtick`,
 * the template content is tokenized with a self-contained JSX grammar that also
 * understands the tagged-template flavor of JSX:
 *
 *   - expression holes              ${expr}
 *   - dynamic component tags        <${Component} ...> ... </${Component}> | <//>
 *   - string / boolean / expression / spread attributes
 *
 * Scope names are the stock VS Code ones so colors come from every theme.
 */

export interface GrammarDefinition {
  scopeName: string;
  injectTo: string[];
  patterns: unknown[];
  repository: Record<string, unknown>;
}

const SCOPE_NAME = "dataverse.tagged-jsx.injection";

function escapeRegexp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagAlternation(tags: string[]): string {
  return tags
    .map(escapeRegexp)
    .sort((a, b) => b.length - a.length)
    .join("|");
}

export function buildTaggedJsxGrammar(tags: string[], injectTo: string[]): GrammarDefinition {
  const tagPattern = tags.length > 0 ? tagAlternation(tags) : "html|jsx";

  return {
    scopeName: SCOPE_NAME,
    injectTo,
    patterns: [
      {
        /*
         * Matches e.g. `html` + backtick. The tag is only highlighted at the
         * position where the backtick immediately follows, keeping plain
         * identifiers untouched.
         */
        comment: "Matches `<tag>` + backtick to open a JSX tagged template.",
        begin: `(?i)(\\b(?:${tagPattern})\\b)(\\s*)(\x60)`,
        beginCaptures: {
          "1": { name: "entity.name.function.tagged-jsx", patterns: [] },
          "3": { name: "punctuation.definition.string.begin.template.js" },
        },
        end: "\x60",
        endCaptures: { "0": { name: "punctuation.definition.string.end.template.js" } },
        patterns: [
          // Substitution code inside the template is TS.
          { include: "source.ts#template-substitution-element" },
          // Everything else is the embedded JSX content.
          { include: "#tagged-jsx-content" },
        ],
      },
    ],
    repository: {
      "tagged-jsx-content": {
        patterns: [
          { include: "#jsx-comment" },
          { include: "#jsx-element" },
          { include: "#jsx-text" },
        ],
      },

      "jsx-text": {
        comment: "Anything that is not markup falls through as text.",
        match: "[^<>{}$]+",
        name: "text.jsx",
      },

      "jsx-comment": {
        comment: "HTML-style comments inside templates (also used as JSX comments).",
        match: "<!--[\\s\\S]*?-->",
        name: "comment.block.tagged-jsx",
      },

      "jsx-element": {
        comment:
          "Cover self-closing `<div/>`, matched `<div> ... </div>`, expression tags " +
          "`<${Component}> ... </${Component}>` and the shorthand close `<//>` by " +
          "treating `<` as the begin and the first `/` or `>` as the end; nested " +
          "elements restart the same rule.",
        begin: "<",
        beginCaptures: { "0": { name: "punctuation.definition.tag.begin.jsx" } },
        end: "/?>",
        endCaptures: {
          "0": { name: "punctuation.definition.tag.end.jsx" },
        },
        patterns: [
          { include: "#jsx-tagname" },
          { include: "#jsx-attribute" },
          // Children reuse the whole content rule set (nested elements etc.)
          { include: "#tagged-jsx-content" },
          { include: "#jsx-close-tag" },
        ],
      },

      "jsx-tagname": {
        comment: "Tag name directly after `<`: html name, registered name, or `${expr}`.",
        match: "[A-Za-z_$][\\w$.:-]*|\\$\\{[^}]*\\}",
        captures: {
          "0": { name: "entity.name.tag.jsx" },
        },
      },

      "jsx-close-tag": {
        comment: "Closing tags `</div>`, `</${Component}>` and the shorthand `<//>`.",
        match: "(</>|</\\s*\\$[^>]*>|<//>)",
        captures: {
          "1": { name: "punctuation.definition.tag.close.jsx", patterns: [] },
        },
      },

      "jsx-attribute": {
        patterns: [
          {
            comment: "Spread `...${expr}`.",
            match: "(\\.\\.\\.)(\\$)(\\{)([^}]*)(\\})",
            captures: {
              "1": { name: "keyword.operator.spread.jsx" },
              "2": { name: "meta.brace.curly.js" },
              "3": { name: "meta.brace.curly.js" },
              "4": { name: "meta.expression.jsx" },
              "5": { name: "meta.brace.curly.js" },
            },
          },
          {
            comment: "`name=\"value\"` / `name='value'`.",
            match: "([A-Za-z_$][\\w$:.-]*)(\\s*=\\s*)(?:\"([^\"]*)\"|'([^']*)')",
            captures: {
              "1": { name: "entity.other.attribute-name.jsx" },
              "2": { name: "punctuation.separator.key-value.jsx" },
              "3": { name: "string.quoted.double.jsx" },
              "4": { name: "string.quoted.single.jsx" },
            },
          },
          {
            comment: "`name=${expr}` (with nested TS skipped for simplicity).",
            begin: "([A-Za-z_$][\\w$:.-]*)(\\s*=\\s*)\\$\\{",
            beginCaptures: {
              "1": { name: "entity.other.attribute-name.jsx" },
              "2": { name: "punctuation.separator.key-value.jsx" },
            },
            end: "\\}",
            endCaptures: { "0": { name: "meta.brace.curly.js" } },
            contentName: "meta.expression.jsx",
          },
          {
            comment: "Boolean attribute (no value).",
            match: "[A-Za-z_$][\\w$:-]*",
            name: "entity.other.attribute-name.jsx",
          },
        ],
      },
    },
  };
}

/** Base64 data URL of the grammar JSON, usable via registerFileUrl on web. */
export function grammarDataUrl(grammar: GrammarDefinition): string {
  const json = JSON.stringify(grammar, null, 2);
  const bytes = new TextEncoder().encode(json);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `data:application/json;base64,${btoa(binary)}`;
}

export const GRAMMAR_FILE_PATH = "syntaxes/generated-tagged-jsx.json";
