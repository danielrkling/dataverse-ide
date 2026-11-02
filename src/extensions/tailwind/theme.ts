/*
 * Candidate generation for Tailwind v4 IntelliSense.
 *
 * The list is derived from Tailwind's own design system instead of a
 * hand-maintained prefix/theme table. That keeps completions, hovers and
 * variants in lock-step with the installed Tailwind version and makes it
 * impossible for this file to silently drift behind the real utility set.
 *
 * The design system is created from the default Tailwind CSS entry by the
 * extension (see compiler.createBundledStylesheetLoader). Callers can pass a
 * different `css` input to include workspace `@theme` / `@utility` rules.
 */

import { __unstable__loadDesignSystem } from "tailwindcss";

export type TailwindDesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

type TailwindCompileOptions = NonNullable<Parameters<typeof __unstable__loadDesignSystem>[1]>;

export type TailwindLoadStylesheet = NonNullable<TailwindCompileOptions["loadStylesheet"]>;

export type TailwindLoadModule = NonNullable<TailwindCompileOptions["loadModule"]>;

export type TailwindCandidate = {
  className: string;
  detail: string;
  documentation?: string;
};

export type VariantCandidate = {
  prefix: string;
};

export type TailwindClassIndex = {
  candidates: TailwindCandidate[];
  variants: VariantCandidate[];
  /** Markdown for a candidate, or undefined when Tailwind rejects it. */
  hoverInfo: (className: string) => string | undefined;
};

const DEFAULT_CSS_INPUT = '@import "tailwindcss";';

/**
 * Every class Tailwind's design system considers valid, including negative
 * utilities (`-mt-4`), fractions (`w-1/2`) and named theme values.
 *
 * Arbitrary values (`w-[13px]`) are valid too but intentionally not
 * enumerated: there are infinitely many, and Tailwind already validates them
 * when the workspace scanner passes them to compile().
 */
export function generateCandidates(designSystem: TailwindDesignSystem): TailwindCandidate[] {
  const seen = new Set<string>();
  const candidates: TailwindCandidate[] = [];

  for (const [className] of designSystem.getClassList()) {
    if (seen.has(className)) {
      continue;
    }

    seen.add(className);

    candidates.push({
      className,
      detail: "Tailwind v4 utility",
    });
  }

  return candidates;
}

function variantName(root: string, value: string | null): string {
  if (value == null) {
    return root;
  }

  /*
   * Container queries use `@sm`, `@max-md`, etc. Every other functional
   * variant uses a dash (`max-md`, `aria-busy`, `group-hover`).
   */
  return root === "@" ? `@${value}` : `${root}-${value}`;
}

/**
 * Variant prefixes that Tailwind accepts without an arbitrary argument.
 *
 * Tailwind's own variant metadata includes static variants (`hover:`, `sm:`)
 * and functional variants whose named values are known (`max-md:`,
 * `aria-busy:`, compound `group-hover:`). Candidates are validated against
 * the design system so variants that require an arbitrary value (`data:`,
 * `supports:`, `nth:`) are not suggested bare.
 */
export function generateVariantCandidates(designSystem: TailwindDesignSystem): VariantCandidate[] {
  const seen = new Set<string>();

  for (const entry of designSystem.getVariants()) {
    const values: (string | null)[] = entry.values.length === 0 ? [null] : entry.values;

    for (const value of values) {
      const name = variantName(entry.name, value);

      /*
       * `flex` is a stable static utility, so this checks only whether the
       * variant itself can be applied without an arbitrary argument.
       */
      if (designSystem.candidatesToCss([`${name}:flex`])[0] == null) {
        continue;
      }

      seen.add(name);
    }
  }

  return [...seen].sort().map((prefix) => ({ prefix: `${prefix}:` }));
}

/**
 * Resolve a candidate to the CSS Tailwind generates for it. Works for
 * utilities, variants and arbitrary values, so hover can explain any class
 * the compiler would accept.
 */
export function getTailwindHoverInfo(
  designSystem: TailwindDesignSystem,
  className: string,
): string | undefined {
  const [css] = designSystem.candidatesToCss([className]);

  if (css == null) {
    return undefined;
  }

  return ["```css", css.trim(), "```"].join("\n");
}

/**
 * Load a design system and build the completion index in one step.
 */
export async function loadTailwindClassIndex(options: {
  css?: string;
  loadStylesheet: TailwindLoadStylesheet;
  loadModule?: TailwindLoadModule;
}): Promise<TailwindClassIndex> {
  const designSystem = await __unstable__loadDesignSystem(options.css ?? DEFAULT_CSS_INPUT, {
    loadStylesheet: options.loadStylesheet,
    loadModule: options.loadModule,
  });

  return {
    candidates: generateCandidates(designSystem),
    variants: generateVariantCandidates(designSystem),
    hoverInfo: (className) => getTailwindHoverInfo(designSystem, className),
  };
}
