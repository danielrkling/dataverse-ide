import { createGlobMatcher, scanGlob } from "../shared/glob.js";

export { createGlobMatcher } from "../shared/glob.js";

/*
 * Glob support for `dataverseIde.flatten.include`, backed by picomatch.
 *
 * Patterns are matched against workspace-relative paths using `/` separators
 * and support picomatch's standard syntax (`*`, `**`, `?`, `{a,b}`, `[...]`,
 * extglobs, and so on). Shared defaults keep dotfiles matchable, matching
 * case-insensitive, and a leading `!` literal.
 */

/*
 * `scan()` reports `isGlob` for normal patterns, but misses a real brace
 * group when a literal one precedes it (`src/{literal}/{a,b}.ts`). This
 * cheap syntax check keeps those patterns on the glob traversal path.
 * Extglob markers only count when followed by `(`, so scoped package paths
 * such as `node_modules/@scope/pkg` stay plain paths.
 */
const GLOB_SYNTAX = /[\[\]*?{}]|[?*+@!]\(/;

export function isGlobPattern(value: string): boolean {
  return scanGlob(value).isGlob || GLOB_SYNTAX.test(value);
}

/*
 * The longest literal prefix of a glob. Traversal starts there, so a pattern
 * like `node_modules/**` can enter `node_modules` even though the folder is
 * normally excluded from recursive folder flattens.
 */
export function globBaseSegments(pattern: string): string[] {
  const scan = scanGlob(pattern);
  const segments = (scan.isGlob ? scan.base : pattern).split("/").filter(Boolean);
  const base: string[] = [];

  for (const segment of segments) {
    if (isGlobPattern(segment)) {
      break;
    }

    base.push(segment);
  }

  return base;
}

/*
 * True when traversal starts inside one of the given directories (for
 * example `node_modules` or `dist`). Such a glob explicitly opts into that
 * subtree, so the caller can stop applying its normal directory exclusions.
 */
export function globStartsInside(pattern: string, directoryNames: ReadonlySet<string>): boolean {
  return globBaseSegments(pattern).some((segment) => directoryNames.has(segment.toLowerCase()));
}
