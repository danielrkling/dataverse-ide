import picomatch from "picomatch";

/*
 * Shared picomatch defaults.
 *
 * `dot` keeps dotfiles matchable, `nocase` keeps path matching
 * case-insensitive, and `nonegate` treats a leading `!` literally instead of
 * turning a pattern into an exclusion. Callers can override these (for
 * example the HTML bundler enables `matchBase` so patterns without a slash
 * match the file name).
 */
export const DEFAULT_GLOB_OPTIONS = {
  dot: true,
  nocase: true,
  nonegate: true,
} as const;

export type GlobMatcherOptions = Parameters<typeof picomatch>[1];

export function createGlobMatcher(
  pattern: string,
  options: GlobMatcherOptions = {},
): (path: string) => boolean {
  return picomatch(pattern, { ...DEFAULT_GLOB_OPTIONS, ...options });
}

export function scanGlob(pattern: string) {
  return picomatch.scan(pattern, DEFAULT_GLOB_OPTIONS);
}

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
 * normally excluded from recursive walks.
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
