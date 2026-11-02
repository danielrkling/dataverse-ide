/*
 * Workspace source scanning for Tailwind candidates.
 *
 * Tailwind itself scans every source file byte-by-byte with a hand-written
 * state machine, then lets the compiler discard anything that is not a real
 * utility. This module follows the same "over-approximate, then validate"
 * model, with a much smaller regex/tokenizer implementation:
 *
 * - quoted strings cover class attributes, template literals and arbitrary
 *   values
 * - a broad token pass covers prose, Markdown, `@apply` lists and unquoted
 *   attribute values
 * - bracket-aware tokenization keeps arbitrary values / variants together
 * - per-extension preprocessing covers syntaxes like Svelte `class:flex`
 *
 * Kept free of vscode / Vite (`?raw`) imports so the parity sanity harness
 * can exercise it directly with Node.
 */

/*
 * Any quoted string: '…', "…", `…`. Template literals are intentionally
 * included: invalid candidates are ignored safely by Tailwind.
 */
const STRING_CAPTURE_PATTERN = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/* Unquoted class attribute values, e.g. class=flex or className={styles.x}. */
const UNQUOTED_CLASS_PATTERN = /\bclass(?:Name)?\s*=\s*([^\s"'`>]+)/g;

/*
 * Broad fallback for tokens outside quoted strings / class attributes, e.g.
 * Markdown prose or CSS `@apply` lists. Brackets and quotes stay inside a
 * token so arbitrary values such as `content-['hello']` survive intact.
 */
const TOKEN_PATTERN = /[A-Za-z0-9_![\]().,#%$@&*:+/'"\\-]+/g;

const MAX_CANDIDATE_LENGTH = 256;

const CANDIDATE_SHAPE = /^[^\s]+$/;

const TRIM_START = /^[\s"'`,;:.=<>\\]+/;
const TRIM_END = /[\s"'`,;:.=<>\\]+$/;

const OPENERS: Record<string, string> = {
  "[": "]",
  "(": ")",
};

/**
 * Small subset of Tailwind's per-extension preprocessors. The source text
 * keeps its length, but syntax that hides class names is made explicit.
 */
function preprocessSource(text: string, extension: string): string {
  switch (extension.toLowerCase()) {
    // `<div class:flex={condition}>` -> `<div class flex={condition}>`
    case "svelte":
      return text.replace(/(^|[\s])class:/g, "$1class ");

    default:
      return text;
  }
}

function matchingCloserIndex(text: string, start: number): number | null {
  const closers: string[] = [];

  for (let index = start; index < text.length; index++) {
    const character = text[index];

    if (OPENERS[character] != null) {
      closers.push(OPENERS[character]);
      continue;
    }

    if (closers.length > 0 && character === closers[closers.length - 1]) {
      closers.pop();

      if (closers.length === 0) {
        return index;
      }
    }
  }

  return null;
}

/*
 * Tailwind's scanner treats `.` as a token boundary (`.filter(` -> `filter`,
 * `container.hidden` -> `container` + `hidden`) but keeps decimal points and
 * dots inside arbitrary values (`p-0.5`, `bg-[url('x.png')]`). Pug/Slim class
 * literals such as `.bg-green-300.2xl:bg-red-500` also need the separator
 * dot split while keeping `2.5xl:`-style numeric variants intact.
 */
function splitToken(raw: string): string[] {
  const parts: string[] = [];
  const closers: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) {
      parts.push(current);
      current = "";
    }
  };

  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    const previous = raw[index - 1];
    const insideBrackets = closers.length > 0;

    /*
     * Quotes delimit nested values (e.g. a class attribute inside a JS
     * string) but are part of arbitrary values (`content-['hello']`).
     */
    if (!insideBrackets && (character === '"' || character === "'" || character === "`")) {
      flush();
      continue;
    }

    if (character === "[" || character === "(") {
      const opensBracket =
        insideBrackets ||
        (character === "[" && (current.length === 0 || previous === "-" || previous === "@")) ||
        (character === "(" && previous === "-");

      if (opensBracket) {
        closers.push(OPENERS[character]);
        current += character;
      } else {
        /*
         * Function calls, array indexes, Angular `[class.foo]` and similar
         * code syntax use brackets as boundaries, not as part of a class.
         */
        flush();
      }

      continue;
    }

    if (character === "]" || character === ")") {
      if (insideBrackets && character === closers[closers.length - 1]) {
        closers.pop();
        current += character;
      } else {
        flush();
      }

      continue;
    }

    if (character === "." && !insideBrackets) {
      const next = raw[index + 1];

      if (previous != null && next != null && /\d/.test(previous) && /\d/.test(next)) {
        let digitsEnd = index + 1;

        while (digitsEnd < raw.length && /\d/.test(raw[digitsEnd])) {
          digitsEnd++;
        }

        const afterDigits = raw[digitsEnd];
        const prefix = current.split(":").pop() ?? current;
        const numericPrefix = /^\d+$/.test(prefix);

        /*
         * `p-0.5` / `2.5xl:` keep the dot. `bg-green-300.2xl:` is two Pug
         * classes, not a decimal.
         */
        if (afterDigits == null || !/[a-zA-Z]/.test(afterDigits) || numericPrefix) {
          current += character;
        } else {
          flush();
        }
      } else {
        flush();
      }

      continue;
    }

    current += character;
  }

  flush();

  return parts;
}

/*
 * Angular/C#/Clojure wrap real classes in bracket expressions that are not
 * arbitrary variants, e.g. `[class.underline]` or `[CssClass("gap-y-4")]`.
 * Mine the inside of those brackets; skip arbitrary variants because they are
 * followed by `:` and are valid candidates on their own.
 */
function bracketSubCandidates(text: string): string[] {
  if (!text.startsWith("[")) {
    return [];
  }

  const end = matchingCloserIndex(text, 0);

  if (end == null || text.slice(end + 1).includes(":")) {
    return [];
  }

  return [text.slice(1, end)];
}

function addCandidate(candidates: string[], seen: Set<string>, raw: string, limit: number): void {
  if (candidates.length >= limit) {
    return;
  }

  const candidate = raw.replace(TRIM_START, "").replace(TRIM_END, "");

  if (
    candidate.length === 0 ||
    candidate.length > MAX_CANDIDATE_LENGTH ||
    !CANDIDATE_SHAPE.test(candidate) ||
    !/[a-zA-Z]/.test(candidate) ||
    candidate.startsWith("$") ||
    seen.has(candidate)
  ) {
    return;
  }

  seen.add(candidate);
  candidates.push(candidate);
}

function addExpandedCandidate(
  candidates: string[],
  seen: Set<string>,
  raw: string,
  limit: number,
): void {
  for (const part of splitToken(raw)) {
    addCandidate(candidates, seen, part, limit);

    for (const inner of bracketSubCandidates(part)) {
      for (const token of inner.split(/\s+/)) {
        for (const subPart of splitToken(token)) {
          addCandidate(candidates, seen, subPart, limit);
        }
      }
    }
  }
}

export function extractCandidates(text: string, limit = 20000, extension = ""): string[] {
  const source = preprocessSource(text, extension);
  const candidates: string[] = [];
  const seen = new Set<string>();

  /*
   * Quoted strings carry class attributes, template literals and arbitrary
   * values. Splitting them on whitespace keeps `content-['hello']` whole.
   */
  for (const pattern of [STRING_CAPTURE_PATTERN, UNQUOTED_CLASS_PATTERN]) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) != null) {
      const rawValue = match[2] ?? match[1];

      for (const token of rawValue.split(/\s+/)) {
        addExpandedCandidate(candidates, seen, token, limit);
      }
    }
  }

  /*
   * Broad token pass: catches candidates in prose, Markdown, CSS `@apply`
   * lists and unquoted attribute values that the targeted patterns miss.
   * Invalid tokens are cheap to reject at compile time.
   */
  TOKEN_PATTERN.lastIndex = 0;

  let tokenMatch: RegExpExecArray | null;

  while ((tokenMatch = TOKEN_PATTERN.exec(source)) != null) {
    addExpandedCandidate(candidates, seen, tokenMatch[0], limit);
  }

  return candidates;
}
