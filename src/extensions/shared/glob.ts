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
