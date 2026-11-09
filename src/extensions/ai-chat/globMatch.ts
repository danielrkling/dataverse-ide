/*
 * Small glob matcher used by find_files.
 *
 * Supports `*` (within one path segment), `?` (one character), and `**`
 * (across segments). Patterns without glob characters are treated as a
 * case-insensitive substring match against the full path and the basename.
 */

export function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }

  return new RegExp(`^${source}$`, "i");
}

export function isGlobPattern(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

export function matchesFindPattern(
  matcher: RegExp | undefined,
  pattern: string,
  path: string,
): boolean {
  const base = path.split("/").pop() ?? path;

  if (matcher != null) {
    return matcher.test(path) || matcher.test(base);
  }

  const lower = pattern.toLowerCase();

  return path.toLowerCase().includes(lower) || base.toLowerCase().includes(lower);
}
