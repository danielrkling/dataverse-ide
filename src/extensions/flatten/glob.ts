/*
 * Glob support for `dataverseIde.flatten.include`, backed by picomatch.
 *
 * Patterns are matched against workspace-relative paths using `/` separators
 * and support picomatch's standard syntax (`*`, `**`, `?`, `{a,b}`, `[...]`,
 * extglobs, and so on). Shared defaults keep dotfiles matchable, matching
 * case-insensitive, and a leading `!` literal.
 *
 * The matcher/traversal helpers live in ../shared/glob.ts so other extensions
 * (for example Tailwind's workspace scan) can use the same semantics.
 */

export {
  createGlobMatcher,
  globBaseSegments,
  globStartsInside,
  isGlobPattern,
} from "../shared/glob.js";
