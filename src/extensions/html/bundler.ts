/*
 * Pure HTML inlining core.
 *
 * This module deliberately has no vscode dependency: the extension supplies
 * workspace-relative read callbacks, and the sanity test can drive it with
 * plain objects. That keeps the parsing/inlining rules easy to test without
 * booting the workbench.
 *
 * HTML parsing is delegated to parse5 (WHATWG HTML5 parser). The resulting
 * tree is rewritten in place and serialized again; formatting may be
 * normalized, which is acceptable for the generated bundle.
 *
 * Supported inlining:
 *   - <script src="…">                     (classic + module scripts)
 *   - <link rel="stylesheet" href="…">     (including nested @import)
 *   - <style>…</style> URL assets
 *   - <img>/<source>/<input type=image>    (src + srcset)
 *   - <link rel="icon"> / apple-touch-icon (href)
 *   - <video>/<audio>                      (src/poster)
 *   - CSS url(…) in inlined stylesheets
 *
 * Remote URLs (http:, https:, //), data:, blob:, mailto:, javascript: and
 * fragment-only references are always left untouched.
 */

import { defaultTreeAdapter, parse, serialize } from "parse5";

import type { DefaultTreeAdapterTypes } from "parse5";

export type HtmlInlineOptions = {
  inlineScripts: boolean;
  inlineStyles: boolean;
  inlineSvg: boolean;
  inlineImages: boolean;
  inlineFonts: boolean;
  inlineCssUrls: boolean;
  maxInlineBytes: number;
  minify: boolean;
  removeComments: boolean;
  /**
   * Glob patterns of workspace paths or original references that should stay
   * external (not inlined). Patterns without a slash match the file name.
   */
  external: string[];
};

export type HtmlBundlerInput = {
  /** Workspace-relative path of the HTML file. */
  path: string;
  /** Raw HTML source. */
  html: string;
  options: HtmlInlineOptions;
  /** Read a workspace-relative UTF-8 text file, or undefined when missing. */
  readText: (path: string) => Promise<string | undefined>;
  /** Read a workspace-relative binary file, or undefined when missing. */
  readBytes: (path: string) => Promise<Uint8Array | undefined>;
  /** Called for every local file the bundler touches (including on failure). */
  onDependency?: (path: string) => void;
};

export type HtmlBundlerResult = {
  html: string;
  dependencies: string[];
  warnings: string[];
};

type Document = DefaultTreeAdapterTypes.Document;
type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type CommentNode = DefaultTreeAdapterTypes.CommentNode;
type DocumentType = DefaultTreeAdapterTypes.DocumentType;
type Attribute = Element["attrs"][number];

const SVG_EXTENSIONS = new Set(["svg"]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "bmp",
  "tif",
  "tiff",
]);

const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

const MIME_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

const ASSET_ATTRIBUTES: Record<string, string[]> = {
  img: ["src"],
  source: ["src"],
  input: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  image: ["href", "xlink:href"],
};

function normalizePath(value: string): string {
  const segments: string[] = [];

  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length > 0) {
        segments.pop();
      } else {
        return `../${segments.join("/")}`;
      }

      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");

  return index === -1 ? "" : path.slice(0, index);
}

function extensionOf(path: string): string {
  const fileName = path.split("/").pop() ?? "";
  const dot = fileName.lastIndexOf(".");

  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/** True for references the bundler should attempt to read from the workspace. */
export function isLocalReference(reference: string): boolean {
  const trimmed = reference.trim();

  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return false;
  }

  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed);
}

/**
 * Resolve a markup/CSS reference against the file that contains it.
 * Returns a workspace-relative path, or undefined for remote references and
 * paths that would escape the workspace root.
 */
export function resolveWorkspaceReference(fromPath: string, reference: string): string | undefined {
  if (!isLocalReference(reference)) {
    return undefined;
  }

  const withoutQuery = reference.trim().split(/[?#]/, 1)[0] ?? "";

  if (withoutQuery.length === 0) {
    return undefined;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }

  const resolved = decoded.startsWith("/")
    ? normalizePath(decoded.slice(1))
    : normalizePath(`${directoryOf(fromPath)}/${decoded}`);

  if (resolved.length === 0 || resolved === ".." || resolved.startsWith("../")) {
    return undefined;
  }

  return resolved;
}

type ExternalMatcher = {
  regex: RegExp;
  basename: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeExternalPattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");

  if (normalized.length === 0) {
    return "";
  }

  // "vendor/" is a convenient directory pattern.
  return normalized.endsWith("/") ? `${normalized}**` : normalized;
}

/**
 * Minimal glob support for external patterns:
 *   *   matches within one path segment
 *   **  matches across segments
 *   ?   matches one non-slash character
 * Patterns are case-insensitive; patterns without a slash match the file name.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;

        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }

      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(character);
  }

  return new RegExp(`${source}$`, "i");
}

function createExternalMatchers(patterns: string[]): ExternalMatcher[] {
  const matchers: ExternalMatcher[] = [];

  for (const pattern of patterns) {
    const normalized = normalizeExternalPattern(pattern);

    if (normalized.length === 0) {
      continue;
    }

    matchers.push({
      regex: globToRegExp(normalized),
      basename: !normalized.includes("/"),
    });
  }

  return matchers;
}

function matchesExternal(
  matchers: ExternalMatcher[],
  reference: string,
  resolved: string,
): boolean {
  if (matchers.length === 0) {
    return false;
  }

  const referencePath = reference.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const referenceWithoutQuery = referencePath.split(/[?#]/, 1)[0] ?? referencePath;
  const basename = resolved.split("/").pop() ?? resolved;
  const referenceBasename = referenceWithoutQuery.split("/").pop() ?? referenceWithoutQuery;

  for (const matcher of matchers) {
    if (matcher.regex.test(resolved) || matcher.regex.test(referencePath)) {
      return true;
    }

    if (
      matcher.basename &&
      (matcher.regex.test(basename) || matcher.regex.test(referenceBasename))
    ) {
      return true;
    }
  }

  return false;
}

function isElementNode(node: ChildNode): node is Element {
  return "tagName" in node;
}

function isTemplate(element: Element): element is Template {
  return element.tagName.toLowerCase() === "template" && "content" in element;
}

function isTextNode(node: ChildNode): node is TextNode {
  return node.nodeName === "#text";
}

function isCommentNode(node: ChildNode): node is CommentNode {
  return node.nodeName === "#comment";
}

function isDocumentTypeNode(node: ChildNode): node is DocumentType {
  return node.nodeName === "#documentType";
}

function attributeKey(attribute: Attribute): string {
  return attribute.prefix != null ? `${attribute.prefix}:${attribute.name}` : attribute.name;
}

function getAttribute(element: Element, name: string): Attribute | undefined {
  const lower = name.toLowerCase();

  return element.attrs.find(
    (attribute) =>
      attributeKey(attribute).toLowerCase() === lower || attribute.name.toLowerCase() === lower,
  );
}

function getAttributeValue(element: Element, name: string): string | undefined {
  return getAttribute(element, name)?.value;
}

function removeAttribute(element: Element, name: string): void {
  const lower = name.toLowerCase();

  element.attrs = element.attrs.filter(
    (attribute) =>
      attributeKey(attribute).toLowerCase() !== lower && attribute.name.toLowerCase() !== lower,
  );
}

function setAttribute(element: Element, name: string, value: string): void {
  const existing = getAttribute(element, name);

  if (existing != null) {
    existing.value = value;
    return;
  }

  const [prefix, localName] = name.includes(":")
    ? [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)]
    : [undefined, name];

  element.attrs.push({
    name: localName,
    value,
    ...(prefix != null
      ? { prefix, namespace: prefix === "xlink" ? XLINK_NAMESPACE : undefined }
      : {}),
  });
}

function textContentOf(element: Element): string {
  let text = "";

  for (const child of element.childNodes) {
    if (isTextNode(child)) {
      text += child.value;
    }
  }

  return text;
}

function setElementText(element: Element, text: string): void {
  element.childNodes = [];

  defaultTreeAdapter.appendChild(element, defaultTreeAdapter.createTextNode(text));
}

function replaceNode(parent: ParentNode, node: ChildNode, replacement: ChildNode): void {
  const children = defaultTreeAdapter.getChildNodes(parent);
  const index = children.indexOf(node);

  if (index === -1) {
    return;
  }

  children[index] = replacement;
  replacement.parentNode = parent;
  node.parentNode = null;
}

function removeNode(parent: ParentNode, node: ChildNode): void {
  const children = defaultTreeAdapter.getChildNodes(parent);
  const index = children.indexOf(node);

  if (index === -1) {
    return;
  }

  children.splice(index, 1);
  node.parentNode = null;
}

function isConditionalComment(comment: CommentNode): boolean {
  return /^\s*\[if\b/i.test(comment.data);
}

function escapeScriptContent(content: string): string {
  return content.replace(/<\/(script)/gi, "<\\/$1");
}

function escapeStyleContent(content: string): string {
  return content.replace(/<\/(style)/gi, "<\\/$1");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + chunkSize)));
  }

  return btoa(binary);
}

function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const entries: { url: string; descriptor: string }[] = [];

  let index = 0;

  while (index < value.length) {
    while (index < value.length && (/\s/.test(value[index]) || value[index] === ",")) {
      index++;
    }

    if (index >= value.length) {
      break;
    }

    const urlStart = index;

    while (index < value.length && !/\s/.test(value[index])) {
      index++;
    }

    let url = value.slice(urlStart, index);
    let descriptor = "";

    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const descriptorStart = index;

      while (index < value.length && value[index] !== ",") {
        index++;
      }

      descriptor = value.slice(descriptorStart, index).trim();

      if (index < value.length && value[index] === ",") {
        index++;
      }
    }

    if (url.length > 0) {
      entries.push({ url, descriptor });
    }
  }

  return entries;
}

/**
 * Inline local references in one HTML document.
 *
 * Throws on missing scripts/stylesheets (and missing CSS @imports): those are
 * structural dependencies, so a silent broken output would be harder to
 * diagnose than a failed build. Missing binary assets are warned about and
 * left as-is.
 */
export async function bundleHtml(input: HtmlBundlerInput): Promise<HtmlBundlerResult> {
  const { options } = input;

  const dependencies = new Set<string>();
  const warnings: string[] = [];

  const externalMatchers = createExternalMatchers(options.external);

  const isExternal = (reference: string, resolved: string): boolean =>
    matchesExternal(externalMatchers, reference, resolved);

  const addDependency = (path: string): void => {
    dependencies.add(path);
    input.onDependency?.(path);
  };

  const readText = async (path: string): Promise<string | undefined> => {
    addDependency(path);

    return input.readText(path);
  };

  const readBytes = async (path: string): Promise<Uint8Array | undefined> => {
    addDependency(path);

    return input.readBytes(path);
  };

  async function assetDataUri(path: string): Promise<string | undefined> {
    const extension = extensionOf(path);

    const kind = SVG_EXTENSIONS.has(extension)
      ? "svg"
      : IMAGE_EXTENSIONS.has(extension)
        ? "image"
        : FONT_EXTENSIONS.has(extension)
          ? "font"
          : undefined;

    if (kind == null) {
      return undefined;
    }

    if (
      (kind === "svg" && !options.inlineSvg) ||
      (kind === "image" && !options.inlineImages) ||
      (kind === "font" && !options.inlineFonts)
    ) {
      return undefined;
    }

    const mime = MIME_TYPES[extension];

    if (mime == null) {
      return undefined;
    }

    const bytes = await readBytes(path);

    if (bytes == null) {
      warnings.push(`Asset "${path}" was not found; leaving its reference unchanged.`);
      return undefined;
    }

    if (options.maxInlineBytes > 0 && bytes.length > options.maxInlineBytes) {
      warnings.push(
        `Asset "${path}" is ${bytes.length} bytes (limit ${options.maxInlineBytes}); leaving its reference unchanged.`,
      );

      return undefined;
    }

    return `data:${mime};base64,${toBase64(bytes)}`;
  }

  /*
   * Inline a binary attribute (img/src, link/href, video/poster, …).
   * Returns true when the attribute was replaced.
   */
  async function inlineAssetAttribute(
    element: Element,
    attributeName: string,
    fromPath: string,
    kinds?: Set<string>,
  ): Promise<boolean> {
    const value = getAttributeValue(element, attributeName);

    if (value == null) {
      return false;
    }

    const resolved = resolveWorkspaceReference(fromPath, value);

    if (resolved == null) {
      return false;
    }

    if (isExternal(value, resolved)) {
      return false;
    }

    if (kinds != null) {
      const extension = extensionOf(resolved);

      const kind = SVG_EXTENSIONS.has(extension)
        ? "svg"
        : IMAGE_EXTENSIONS.has(extension)
          ? "image"
          : FONT_EXTENSIONS.has(extension)
            ? "font"
            : undefined;

      if (kind == null || !kinds.has(kind)) {
        return false;
      }
    }

    const dataUri = await assetDataUri(resolved);

    if (dataUri == null) {
      return false;
    }

    setAttribute(element, attributeName, dataUri);

    return true;
  }

  async function inlineSrcset(
    element: Element,
    attributeName: string,
    fromPath: string,
  ): Promise<boolean> {
    const value = getAttributeValue(element, attributeName);

    if (value == null) {
      return false;
    }

    const entries = parseSrcset(value);

    let changed = false;

    for (const entry of entries) {
      const resolved = resolveWorkspaceReference(fromPath, entry.url);

      if (resolved == null) {
        continue;
      }

      if (isExternal(entry.url, resolved)) {
        continue;
      }

      const dataUri = await assetDataUri(resolved);

      if (dataUri != null) {
        entry.url = dataUri;
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }

    setAttribute(
      element,
      attributeName,
      entries
        .map((entry) =>
          entry.descriptor.length > 0 ? `${entry.url} ${entry.descriptor}` : entry.url,
        )
        .join(", "),
    );

    return true;
  }

  async function processCss(css: string, cssPath: string, stack: Set<string>): Promise<string> {
    /*
     * 1. Inline local @import rules recursively. Imported content is
     *    processed in its own file's base directory.
     */
    const importPattern =
      /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;

    let withImports = "";
    let lastIndex = 0;

    for (const match of css.matchAll(importPattern)) {
      const start = match.index ?? 0;
      const importText = match[0];
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
      const media = (match[6] ?? "").trim();

      withImports += css.slice(lastIndex, start);
      lastIndex = start + importText.length;

      if (!isLocalReference(specifier)) {
        withImports += importText;
        continue;
      }

      const resolved = resolveWorkspaceReference(cssPath, specifier);

      if (resolved == null) {
        warnings.push(
          `@import "${specifier}" in "${cssPath}" escapes the workspace; leaving it unchanged.`,
        );

        withImports += importText;
        continue;
      }

      if (isExternal(specifier, resolved)) {
        withImports += importText;
        continue;
      }

      if (stack.has(resolved)) {
        warnings.push(`@import cycle detected at "${resolved}" (in "${cssPath}"); skipping.`);

        continue;
      }

      const imported = await readText(resolved);

      if (imported == null) {
        throw new Error(`Stylesheet @import "${specifier}" could not be read from "${cssPath}".`);
      }

      const nextStack = new Set(stack);
      nextStack.add(resolved);

      const processed = await processCss(imported, resolved, nextStack);

      withImports += media.length > 0 ? `@media ${media} {\n${processed}\n}` : processed;
    }

    withImports += css.slice(lastIndex);

    if (!options.inlineCssUrls) {
      return withImports;
    }

    /*
     * 2. Replace local url(…) references with data URIs, resolved relative
     *    to the stylesheet that contains them.
     */
    const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)/gi;

    let result = "";
    lastIndex = 0;

    for (const match of withImports.matchAll(urlPattern)) {
      const start = match.index ?? 0;
      const urlText = match[0];
      const specifier = (match[1] ?? match[2] ?? match[3] ?? "").trim();

      result += withImports.slice(lastIndex, start);
      lastIndex = start + urlText.length;

      const resolved = resolveWorkspaceReference(cssPath, specifier);

      if (resolved == null || isExternal(specifier, resolved)) {
        result += urlText;
        continue;
      }

      const dataUri = await assetDataUri(resolved);

      result += dataUri != null ? `url("${dataUri}")` : urlText;
    }

    result += withImports.slice(lastIndex);

    return result;
  }

  async function processScript(element: Element): Promise<void> {
    if (!options.inlineScripts) {
      return;
    }

    const source = getAttributeValue(element, "src");

    if (source == null) {
      return;
    }

    const resolved = resolveWorkspaceReference(input.path, source);

    if (resolved == null || isExternal(source, resolved)) {
      return;
    }

    const script = await readText(resolved);

    if (script == null) {
      throw new Error(`Script "${source}" could not be read (referenced from "${input.path}").`);
    }

    removeAttribute(element, "src");
    removeAttribute(element, "integrity");
    removeAttribute(element, "crossorigin");
    removeAttribute(element, "referrerpolicy");
    removeAttribute(element, "async");
    removeAttribute(element, "defer");

    /*
     * parse5 serializes script text as raw text, so a literal </script> in
     * the source would terminate the element early in the browser.
     */
    setElementText(element, escapeScriptContent(script));
  }

  async function processStyle(element: Element): Promise<void> {
    if (!options.inlineCssUrls) {
      return;
    }

    const content = textContentOf(element);

    if (content.length === 0) {
      return;
    }

    const processed = await processCss(content, input.path, new Set([input.path]));

    if (processed === content) {
      return;
    }

    setElementText(element, escapeStyleContent(processed));
  }

  async function processLink(element: Element, parent: ParentNode): Promise<void> {
    const rel = (getAttributeValue(element, "rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0);

    const href = getAttributeValue(element, "href");

    if (options.inlineStyles && rel.includes("stylesheet") && href != null) {
      if (!isLocalReference(href)) {
        return;
      }

      const resolved = resolveWorkspaceReference(input.path, href);

      if (resolved == null) {
        warnings.push(`Stylesheet "${href}" escapes the workspace; leaving it unchanged.`);

        return;
      }

      if (isExternal(href, resolved)) {
        return;
      }

      const css = await readText(resolved);

      if (css == null) {
        throw new Error(
          `Stylesheet "${href}" could not be read (referenced from "${input.path}").`,
        );
      }

      const processed = await processCss(css, resolved, new Set([resolved]));

      const styleAttributes = element.attrs.filter((attribute) => {
        const name = attributeKey(attribute).toLowerCase();

        return (
          name !== "href" &&
          name !== "rel" &&
          name !== "as" &&
          name !== "crossorigin" &&
          name !== "integrity" &&
          name !== "referrerpolicy" &&
          name !== "disabled"
        );
      });

      const styleElement = defaultTreeAdapter.createElement(
        "style",
        element.namespaceURI,
        styleAttributes,
      );

      setElementText(styleElement, escapeStyleContent(processed));
      replaceNode(parent, element, styleElement);

      return;
    }

    if (
      rel.some((token) => ["icon", "shortcut", "apple-touch-icon", "mask-icon"].includes(token))
    ) {
      await inlineAssetAttribute(element, "href", input.path, new Set(["svg", "image"]));

      return;
    }

    if (rel.includes("preload")) {
      const as = (getAttributeValue(element, "as") ?? "").toLowerCase();

      if (as === "image" || as === "font") {
        await inlineAssetAttribute(element, "href", input.path);
      }
    }
  }

  async function processAssetAttributes(element: Element): Promise<void> {
    if (
      element.tagName.toLowerCase() === "input" &&
      (getAttributeValue(element, "type") ?? "").toLowerCase() !== "image"
    ) {
      return;
    }

    const assetAttributes = ASSET_ATTRIBUTES[element.tagName.toLowerCase()];

    if (assetAttributes == null) {
      return;
    }

    for (const attributeName of assetAttributes) {
      await inlineAssetAttribute(element, attributeName, input.path);
    }

    await inlineSrcset(element, "srcset", input.path);
  }

  async function processElement(element: Element, parent: ParentNode): Promise<void> {
    const tagName = element.tagName.toLowerCase();

    if (tagName === "script") {
      await processScript(element);
      return;
    }

    if (tagName === "style") {
      await processStyle(element);
      return;
    }

    if (tagName === "link") {
      await processLink(element, parent);
      return;
    }

    await processAssetAttributes(element);

    if (isTemplate(element)) {
      await walk(element.content);
      return;
    }

    await walk(element);
  }

  async function walk(parent: ParentNode): Promise<void> {
    const children = defaultTreeAdapter.getChildNodes(parent);

    for (const child of [...children]) {
      if (isCommentNode(child)) {
        if (options.removeComments && !isConditionalComment(child)) {
          removeNode(parent, child);
        }

        continue;
      }

      if (isTextNode(child) || isDocumentTypeNode(child)) {
        continue;
      }

      if (isElementNode(child)) {
        await processElement(child, parent);
      }
    }
  }

  const document: Document | DocumentFragment = parse(input.html);

  await walk(document);

  let html = serialize(document);

  if (options.minify) {
    html = minifyHtml(html);
  }

  return {
    html,
    dependencies: [...dependencies],
    warnings,
  };
}

/**
 * Conservative HTML minification: collapse runs of whitespace and trim
 * whitespace between tags, while leaving the contents of pre/textarea/
 * script/style untouched.
 */
export function minifyHtml(html: string): string {
  const protectedBlocks: string[] = [];

  const tokenized = html.replace(
    /<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    (block) => {
      protectedBlocks.push(block);

      return `\u0000HTML_BLOCK_${protectedBlocks.length - 1}\u0000`;
    },
  );

  const minified = tokenized.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();

  return minified.replace(/\u0000HTML_BLOCK_(\d+)\u0000/g, (_, index: string) => {
    return protectedBlocks[Number(index)] ?? "";
  });
}
