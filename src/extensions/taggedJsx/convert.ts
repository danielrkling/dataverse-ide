/*
 * Tagged JSX conversion engine.
 *
 * Converts between tagged template literals (`html`<div />` / `<${Comp} />`)
 * and standard JSX syntax (`<div />` / `<Comp />`) the way the "Tagged JSX
 * Tools" VS Code extension does.
 *
 * Strategy: the document is parsed with Prettier's bundled babel/TypeScript
 * parsers (already part of the bundle for formatting), which yield full ASTs
 * with source offsets:
 *
 *  - TaggedTemplateExpression nodes locate tagged templates; quasis +
 *    expression nodes give the exact raw-strings/substitution split the
 *    runtime receives.
 *  - JSXElement / JSXFragment nodes locate JSX markup.
 *
 * The tagged-template side is re-parsed with @tagged-jsx/parse (tokenize +
 * parse over the raw strings) to build the element tree, including the tagged
 * flavor: dynamic tags `<${Comp}>`, shorthand close `<//>`, and `${expr}`
 * holes.
 *
 * "Use callbacks" mode bridges SolidJS eager-eval JSX with tagged-template
 * lazy thunks by wrapping/unwrapping zero-parameter arrow functions.
 */

import * as prettierParsersTypescript from "prettier/plugins/typescript";
import * as prettierParsersBabel from "prettier/plugins/babel";
import { parse as parseTaggedJsx, tokenize } from "@tagged-jsx/parse";

export interface ConvertOptions {
  /** Tag identifiers treated as JSX tagged templates (e.g. ["html", "jsx"]). */
  tags: string[];
  /** Tag used when generating a tagged template from JSX. */
  preferredTag: string;
  /** SolidJS reactive-expression bridging (wrap/unwrap `() =>`). */
  useCallbacks: boolean;
  /** Component names emitted as literal tag names instead of `<${...}>`. */
  registeredComponents: string[];
}

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

export interface ConversionResult {
  edits: SourceEdit[];
  /** Present when the source had something we recognized but could not convert. */
  encounteredError?: string;
}

type AstNode = any;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const TS_EXTENSIONS = ["ts", "tsx", "mts", "cts"];

function fileExtension(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  const dot = base.lastIndexOf(".");

  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function parserFor(fileName: string): "typescript" | "babel" {
  return TS_EXTENSIONS.includes(fileExtension(fileName)) ? "typescript" : "babel";
}

function parseDocument(source: string, fileName: string): AstNode {
  const chooseTypescript = parserFor(fileName) === "typescript";
  const parse = (
    chooseTypescript
      ? prettierParsersTypescript.parsers.typescript
      : prettierParsersBabel.parsers.babel
  ).parse as (text: string, options?: unknown, context?: unknown) => AstNode;

  return parse(source, {}, { encoding: "utf8" });
}

interface NodeRange {
  start: number;
  end: number;
}

function rangeOf(node: AstNode): NodeRange {
  if (node.range != null) {
    return { start: node.range[0], end: node.range[1] };
  }

  return { start: node.start ?? 0, end: node.end ?? 0 };
}

function isJsxNode(node: AstNode): boolean {
  return node.type === "JSXElement" || node.type === "JSXFragment";
}

/*
 * The two bundled parsers (babel and TypeScript/estree) shape JSX nodes
 * slightly differently: the TypeScript dialect keeps name/attributes on
 * `openingElement` and marks string literals as "Literal". Normalize to one
 * dialect at the emission boundary.
 */
function jsxNameNode(node: AstNode): AstNode | undefined {
  return node.name ?? node.openingElement?.name;
}

function jsxAttributes(node: AstNode): AstNode[] {
  return node.attributes ?? node.openingElement?.attributes ?? [];
}

function jsxChildren(node: AstNode): AstNode[] {
  return node.children ?? [];
}

function isStringLiteralNode(node: AstNode): boolean {
  const type = String(node.type ?? "");

  return type === "StringLiteral" || (type === "Literal" && typeof node.value === "string");
}

/** Walks children of a JSON-ish AST node, calling `visit` on every node. */
function forEachNode(node: unknown, visit: (child: AstNode) => void): void {
  if (node == null || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      forEachNode(entry, visit);
    }

    return;
  }

  visit(node as AstNode);

  for (const value of Object.values(node as Record<string, unknown>)) {
    forEachNode(value, visit);
  }
}

/* ------------------------------------------------------------------ */
/* Configured tag matching                                             */
/* ------------------------------------------------------------------ */

function isConfiguredTagNode(node: AstNode, tags: string[]): boolean {
  if (node.type === "Identifier") {
    return tags.includes(node.name);
  }

  // Support `html.jsx` self-reference style tags.
  if (node.type === "MemberExpression" && !node.computed) {
    return tags.includes(String(node.property?.name ?? ""));
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Lazy (useCallbacks) expression bridging                             */
/* ------------------------------------------------------------------ */

function containsFunction(expr: string): boolean {
  return /=>/.test(expr) || /\bfunction\b/.test(expr);
}

const PRIMITIVE_PATTERN =
  /^(?:true|false|null|undefined|this|-?\d+(?:\.\d+)?|0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*")|`[^`]*`)$/;

function isPrimitiveExpression(expr: string): boolean {
  return PRIMITIVE_PATTERN.test(expr.trim());
}

function isHandlerProp(propName: string): boolean {
  return /^(on[A-Z]|ref$)/.test(propName);
}

/** JSX (eager) -> tagged template (lazy): wrap with `() =>` where needed. */
function wrapLazy(expr: string, propName: string | undefined, options: ConvertOptions): string {
  if (!options.useCallbacks || containsFunction(expr) || isPrimitiveExpression(expr)) {
    return expr;
  }

  if (propName != null && isHandlerProp(propName)) {
    return expr;
  }

  // Object literals need parens so they don't parse as the arrow's block body.
  const trimmed = expr.trim();

  if (/^\{[\s\S]*\}$/.test(trimmed)) {
    return `() => (${trimmed})`;
  }

  return `() => ${trimmed}`;
}

/** Tagged template (lazy) -> JSX (eager): unwrap zero-parameter arrows. */
function unwrapLazy(expr: string, options: ConvertOptions): string {
  if (!options.useCallbacks) {
    return expr;
  }

  const match = /^\(\s*\)\s*=>\s*([\s\S]+)$/.exec(expr.trim());

  if (match == null) {
    return expr;
  }

  let body = match[1].trim();

  // `() => ({a: 1})` -> `{a: 1}` (restored to a bare object literal).
  if (/^\(\{[\s\S]*\}\)$/.test(body)) {
    body = body.slice(1, -1).trim();
  }

  return body;
}

/* ------------------------------------------------------------------ */
/* Replacement index (inner conversions spliced into outer slices)     */
/* ------------------------------------------------------------------ */

class ReplacementIndex {
  private readonly items: SourceEdit[] = [];

  add(edit: SourceEdit): void {
    this.items.push(edit);
  }

  /** `source.slice(start, end)` with replaced ranges spliced in. */
  slice(source: string, start: number, end: number): string {
    const replacements = this.items
      .filter((item) => item.start >= start && item.end <= end && item.start !== item.end)
      .sort((a, b) => a.start - b.start);

    let out = "";
    let cursor = start;

    for (const item of replacements) {
      out += source.slice(cursor, item.start);
      out += item.text;
      cursor = item.end;
    }

    return out + source.slice(cursor, end);
  }
}

interface TypeContext {
  source: string;
  options: ConvertOptions;
  replacements: ReplacementIndex;
}

/* ------------------------------------------------------------------ */
/* Direction: tagged template -> JSX                                   */
/* ------------------------------------------------------------------ */

function findTaggedTemplates(ast: AstNode, tags: string[]): AstNode[] {
  const templates: AstNode[] = [];

  forEachNode(ast, (node) => {
    if (node.type === "TaggedTemplateExpression" && isConfiguredTagNode(node.tag, tags)) {
      templates.push(node);
    }
  });

  // Innermost templates first: a template nested inside another template's
  // substitution converts first, and the outer emission then splices the
  // already-converted text into its holes via the ReplacementIndex.
  return templates.sort((a, b) => rangeOf(b).start - rangeOf(a).start);
}

function emitJsxFromTemplate(template: AstNode, ctx: TypeContext): string {
  const { source, options } = ctx;
  const quasi = template.quasi;
  const strings = (quasi.quasis as AstNode[]).map((element) => element.value.raw);
  const tokens = tokenize(strings);
  const tree = parseTaggedJsx(tokens, strings);

  function substitution(i: number): string {
    const exprNode = quasi.expressions[i];
    const { start, end } = rangeOf(exprNode);
    const text = ctx.replacements.slice(source, start, end);

    return unwrapLazy(text, options);
  }

  /* Element name on the tagged side: string (html name or registered
   * component) or number (index into `strings` = an expression hole). */
  function tagName(name: string | number): string {
    if (typeof name === "string") {
      return name;
    }

    // Dynamic tag: `<${Comp}>` -> `<Comp>`. The hole is usually a plain
    // identifier / member chain used verbatim as the JSX tag name.
    return substitution(name)
      .trim()
      .replace(/^\(([\s\S]*)\)$/, "$1");
  }

  function emitProp(prop: AstNode): string {
    switch (prop.type) {
      case "BOOLEAN":
        return prop.name;

      case "STRING": {
        const value = String(prop.value).replace(/"/g, "&quot;");

        return `${prop.name}="${value}"`;
      }

      case "EXPRESSION":
        return `${prop.name}={${substitution(prop.value)}}`;

      case "SPREAD":
        return `{...${substitution(prop.value)}}`;

      default:
        return "";
    }
  }

  function emitChild(child: AstNode): string {
    switch (child.type) {
      case "TEXT":
        return String(child.value);

      case "EXPRESSION":
        return `{${substitution(child.value)}}`;

      case "ELEMENT":
        return emitElement(child);

      case "COMMENT": {
        const text = child.children
          .map((part: AstNode) => (part.type === "TEXT" ? part.value : substitution(part.value)))
          .join("");

        return `{/*${text}*/}`;
      }

      default:
        return "";
    }
  }

  function emitElement(node: AstNode): string {
    const name = tagName(node.name);
    const props = node.props
      .map((prop: AstNode) => emitProp(prop))
      .filter(Boolean)
      .join(" ");
    const open = `<${name}${props.length > 0 ? ` ${props}` : ""}`;

    if (node.children.length === 0) {
      return `${open} />`;
    }

    return `${open}>${node.children.map((child: AstNode) => emitChild(child)).join("")}</${name}>`;
  }

  return tree.children.map((child: AstNode) => emitChild(child)).join("");
}

function convertTemplatesToJsx(
  source: string,
  fileName: string,
  options: ConvertOptions,
): ConversionResult {
  const ast = parseDocument(source, fileName);
  const templates = findTaggedTemplates(ast, options.tags);
  const replacements = new ReplacementIndex();
  const ctx: TypeContext = { source, options, replacements };
  const edits: SourceEdit[] = [];

  for (const node of templates) {
    let text: string;

    try {
      text = emitJsxFromTemplate(node, ctx);
    } catch (error) {
      return {
        edits: [],
        encounteredError: `Tagged template at offset ${rangeOf(node).start}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const edit = { ...rangeOf(node), text };
    edits.push(edit);
    replacements.add(edit);
  }

  // Same top-level filter as the JSX direction: templates nested inside
  // another template's substitutions were already spliced into the outer
  // emission; returning them too would double-apply.
  const topLevel = edits.filter(
    (edit) =>
      !edits.some(
        (other) =>
          other !== edit &&
          other.start <= edit.start &&
          other.end >= edit.end &&
          size(other) > size(edit),
      ),
  );

  return { edits: topLevel };
}

/* ------------------------------------------------------------------ */
/* Direction: JSX -> tagged template                                   */
/* ------------------------------------------------------------------ */

/**
 * Collects "top-level" JSX roots: JSX nodes whose ancestors contain no other
 * JSX node — except that subtrees inside JSXExpressionContainer count as
 * fresh scopes, so markup nested inside expressions (e.g.
 * `items.map(i => <li />)`) is collected too: it must become a nested tagged
 * template instead of raw JSX inside a hole.
 */
function collectJsxRoots(ast: AstNode): AstNode[] {
  const roots: AstNode[] = [];

  function walk(node: unknown, hasJsxAncestor: boolean): void {
    if (node == null || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, hasJsxAncestor);
      }

      return;
    }

    const typed = node as AstNode;
    const isJsx = typed.type != null && isJsxNode(typed);

    if (isJsx && !hasJsxAncestor) {
      roots.push(typed);
    }

    if (typed.type === "JSXExpressionContainer" && typed.expression != null) {
      // Fresh scope: the container's expression subtree has no JSX ancestor.
      walk(typed.expression, false);

      return;
    }

    const jsxFromHere = hasJsxAncestor || isJsx;

    for (const value of Object.values(typed as Record<string, unknown>)) {
      walk(value, jsxFromHere);
    }
  }

  walk(ast, false);

  return roots.sort((a, b) => rangeOf(a).start - rangeOf(b).start);
}

function isComponentName(name: string): boolean {
  const first = name[0] ?? "";

  return /[A-Z]/.test(first) || name.includes(".") || name.includes(":");
}

interface EmitContext {
  source: string;
  options: ConvertOptions;

  /** Slices a region, splicing in already-converted inner JSX edits. */
  range: (start: number, end: number) => string;
}

function expressionSlice(node: AstNode, ctx: EmitContext): string {
  const { start, end } = rangeOf(node);

  return ctx.range(start, end);
}

function emitChildNode(node: AstNode, ctx: EmitContext): string {
  if (node.type === "JSXText") {
    return node.value;
  }

  if (node.type === "JSXExpressionContainer") {
    if (node.expression == null || node.expression.type === "JSXEmptyExpression") {
      return "";
    }

    if (isStringLiteralNode(node.expression)) {
      return expressionSlice(node.expression, ctx);
    }

    const expr = expressionSlice(node.expression, ctx);

    return `\${${wrapLazy(expr, undefined, ctx.options)}}`;
  }

  if (node.type === "JSXSpreadChild") {
    return `\${...${expressionSlice(node.expression, ctx).trim()}}`;
  }

  if (isJsxNode(node)) {
    return emitJsxNode(node, ctx);
  }

  return "";
}

function emitElement(node: AstNode, ctx: EmitContext): string {
  const name = expressionSlice(jsxNameNode(node)!, ctx).trim();
  const component = isComponentName(name);
  const literalTag = ctx.options.registeredComponents.includes(name);
  const tag = component && !literalTag ? `\${${name}}` : name;

  const parts: string[] = [];

  for (const attr of jsxAttributes(node)) {
    switch (attr.type) {
      case "JSXAttribute": {
        const attrName = expressionSlice(attr.name, ctx).trim();

        if (attr.value == null) {
          parts.push(attrName);

          continue;
        }

        if (isStringLiteralNode(attr.value)) {
          const raw = String(
            attr.value.extra?.rawValue ?? attr.value.extra?.raw ?? trimQuotes(attr.value.value),
          );

          parts.push(`${attrName}="${raw.replace(/"/g, "&quot;")}"`);

          continue;
        }

        if (attr.value.type === "JSXExpressionContainer") {
          const expr = expressionSlice(attr.value.expression, ctx);

          parts.push(`${attrName}=\${${wrapLazy(expr, attrName, ctx.options)}}`);

          continue;
        }

        parts.push(`${attrName}="${expressionSlice(attr.value, ctx).trim()}"`);

        continue;
      }

      case "JSXSpreadAttribute":
        parts.push(`...\${${expressionSlice(attr.argument, ctx).trim()}}`);

        continue;

      default:
        continue;
    }
  }

  const open = `<${tag}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
  const children = jsxChildren(node).filter(
    (child: AstNode) => child.type !== "JSXText" || child.value.trim() !== "",
  );

  if (children.length === 0) {
    return `${open} />`;
  }

  const body = children.map((child: AstNode) => emitChildNode(child, ctx)).join("");

  // `<//>` shorthand close for hole components.
  const close = component && !literalTag ? "<//>" : `</${tag}>`;

  return `${open}>${body}${close}`;
}

function trimQuotes(value: unknown): string {
  const text = String(value ?? "");

  return text.length >= 2 && /^["']/.test(text) ? text.slice(1, -1) : text;
}

function emitFragment(node: AstNode, ctx: EmitContext): string {
  const children = jsxChildren(node)
    .map((child: AstNode) => emitChildNode(child, ctx))
    .join("");

  return `<Fragment>${children}</Fragment>`;
}

function emitJsxNode(node: AstNode, ctx: EmitContext): string {
  return node.type === "JSXFragment" ? emitFragment(node, ctx) : emitElement(node, ctx);
}

function convertJsxToTemplates(
  source: string,
  fileName: string,
  options: ConvertOptions,
): ConversionResult {
  const ast = parseDocument(source, fileName);
  const roots = collectJsxRoots(ast);
  const edits: SourceEdit[] = [];

  /*
   * Roots are converted innermost-first (smallest range first) so that JSX
   * nested inside an outer root's expression containers is already converted
   * when the outer emission splices its replacement into child slices.
   */
  const ordered = [...roots].sort((a, b) => rangeSize(a) - rangeSize(b));

  for (const root of ordered) {
    const { start, end } = rangeOf(root);
    const replacements = new ReplacementIndex();
    const ctx: EmitContext = {
      source,
      options,
      range: (sliceStart, sliceEnd) => replacements.slice(source, sliceStart, sliceEnd),
    };

    for (const prior of edits) {
      if (prior.start >= start && prior.end <= end) {
        replacements.add(prior);
      }
    }

    let content: string;

    try {
      content = emitJsxNode(root, ctx);
    } catch (error) {
      return {
        edits: [],
        encounteredError: `JSX at offset ${start}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    edits.push({ start, end, text: `${preferredTagFor(options)}\`${content}\`` });
  }

  /*
   * Only top-level edits are returned: nested (container-inner) conversions
   * were already spliced into their enclosing root's text, and returning them
   * too would apply them twice. Keep an edit only when no other edit fully
   * contains it.
   */
  const topLevel = edits.filter(
    (edit) =>
      !edits.some(
        (other) =>
          other !== edit &&
          other.start <= edit.start &&
          other.end >= edit.end &&
          size(other) > size(edit),
      ),
  );

  return { edits: topLevel };
}

function size(edit: SourceEdit): number {
  return edit.end - edit.start;
}

function rangeSize(node: AstNode): number {
  const { start, end } = rangeOf(node);

  return end - start;
}

function preferredTagFor(options: ConvertOptions): string {
  return options.tags.includes(options.preferredTag)
    ? options.preferredTag
    : (options.tags[0] ?? "html");
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Ascending start so sequential edits (e.g. in tests) apply inner-first. */
export function serializeEdits(edits: SourceEdit[]): SourceEdit[] {
  return [...edits].sort((a, b) => a.start - b.start);
}

export function applySourceEdits(source: string, edits: SourceEdit[]): string {
  // Edits never overlap; the output is rebuilt off the original source so
  // absolute offsets stay valid after any replacement.
  const sorted = serializeEdits(edits);
  let out = "";
  let cursor = 0;

  for (const edit of sorted) {
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = Math.max(cursor, edit.end);
  }

  return out + source.slice(cursor);
}

function escapeRegexp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasConfiguredTaggedTemplate(source: string, options: ConvertOptions): boolean {
  const pattern = new RegExp(`\\b(?:${options.tags.map(escapeRegexp).join("|")})\\b\\s*\x60`);

  return pattern.test(source);
}

function withinBounds(edit: SourceEdit, bounds?: { start: number; end: number }): boolean {
  return bounds == null || (edit.start >= bounds.start && edit.end <= bounds.end);
}

/** Converts every tagged template in the source to JSX. */
export function convertTaggedSourceToJsx(
  source: string,
  fileName: string,
  options: ConvertOptions,
  bounds?: { start: number; end: number },
): ConversionResult {
  const result = convertTemplatesToJsx(source, fileName, options);

  if (bounds == null || result.edits.length === 0) {
    return result;
  }

  return { ...result, edits: result.edits.filter((edit) => withinBounds(edit, bounds)) };
}

/** Converts every JSX root in the source to a tagged template. */
export function convertJsxSourceToTagged(
  source: string,
  fileName: string,
  options: ConvertOptions,
  bounds?: { start: number; end: number },
): ConversionResult {
  const result = convertJsxToTemplates(source, fileName, options);

  if (bounds == null || result.edits.length === 0) {
    return result;
  }

  return { ...result, edits: result.edits.filter((edit) => withinBounds(edit, bounds)) };
}

export type ConvertDirection = "toJsx" | "toTagged";

/**
 * Smart toggle: decides the direction by what the source contains — tagged
 * templates win (convert to JSX); otherwise JSX roots convert to tagged
 * templates.
 */
export function smartConvertSource(
  source: string,
  fileName: string,
  options: ConvertOptions,
): ConversionResult & { direction?: ConvertDirection } {
  if (hasConfiguredTaggedTemplate(source, options)) {
    const result = convertTemplatesToJsx(source, fileName, options);

    return { ...result, direction: result.edits.length > 0 ? "toJsx" : undefined };
  }

  let ast: AstNode;

  try {
    ast = parseDocument(source, fileName);
  } catch (error) {
    return {
      edits: [],
      encounteredError: error instanceof Error ? error.message : String(error),
    };
  }

  if (collectJsxRoots(ast).length > 0) {
    const result = convertJsxToTemplates(source, fileName, options);

    return { ...result, direction: result.edits.length > 0 ? "toTagged" : undefined };
  }

  return { edits: [] };
}

/*
 * Selection-based JSX -> tagged template: the selection is parsed as a
 * standalone expression (wrapped in a synthetic statement, so offsets shift
 * by the prefix length) and converted.
 */
export function convertSelectionToTagged(
  selectionText: string,
  fileName: string,
  options: ConvertOptions,
): ConversionResult {
  const prefix = "const __taggedJsxSelection = (";
  const synthetic = `${prefix}${selectionText});`;
  const shift = prefix.length;

  // Reuse the document conversion on the synthetic snippet, then rebase the
  // resulting edits out of the synthetic wrapper. Only the outermost root's
  // edit matters: nested JSX inside expression containers is already
  // spliced into it during emission.
  const result = convertJsxToTemplates(synthetic, fileName, options);

  if (result.edits.length === 0) {
    if (result.encounteredError != null) {
      return { edits: [], encounteredError: result.encounteredError };
    }

    return { edits: [], encounteredError: "Selection does not contain JSX." };
  }

  /*
   * The outermost root is the first-root edit (smallest start). Example:
   * leading whitespace in the selection puts it just after the prefix; pick
   * the edit that covers everything the user selected: the maximum span that
   * starts nearest to the prefix. Nested JSX is already spliced into it.
   */
  const outer = result.edits
    .filter((inner: SourceEdit) => inner.end <= shift + selectionText.length)
    .sort((a: SourceEdit, b: SourceEdit) => a.start - b.start)[0];

  if (outer == null) {
    return { edits: [], encounteredError: "Selection does not contain JSX." };
  }

  return {
    edits: [
      {
        start: Math.max(0, outer.start - shift),
        end: Math.min(selectionText.length, outer.end - shift),
        text: outer.text,
      },
    ],
  };
}
