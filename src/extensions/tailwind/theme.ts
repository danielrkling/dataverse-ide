/*
 * Candidate generation for Tailwind v4 utilities, driven by the default
 * theme data shipped with the tailwindcss package (plain JS, no WASM).
 *
 * This is IntelliSense-grade: completions with resolved values for hover.
 * Full JIT CSS generation (arbitrary variants etc.) is not attempted here -
 * that stays with the @tailwindcss/browser preview path.
 */
import defaultThemeExport from 'tailwindcss/defaultTheme'

type ThemeValue = unknown
type ThemeObject = Record<string, ThemeValue>

const defaultTheme = defaultThemeExport as ThemeObject

export type ThemeFn = (key: string) => Record<string, string | string[]>

const resolvedCache = new Map<string, Record<string, string | string[]>>()

function isPlainObject(value: ThemeValue): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value != null &&
    !Array.isArray(value) &&
    !(typeof value === 'function')
  )
}

export function resolveThemeField(field: string): Record<
  string,
  string | string[]
> {
  const cached = resolvedCache.get(field)

  if (cached != null) {
    return cached
  }

  const value = defaultTheme[field]

  if (isPlainObject(value)) {
    // Plain object: normalize nested color stops (e.g. slate.50)
    const resolved: Record<string, string | string[]> = {}

    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        resolved[key] = entry
      } else if (Array.isArray(entry)) {
        resolved[key] = entry.map((element) =>
          typeof element === 'string' ? element : JSON.stringify(element),
        )
      } else if (isPlainObject(entry)) {
        for (const [nestedKey, nestedEntry] of Object.entries(entry)) {
          if (typeof nestedEntry === 'string') {
            resolved[`${key}.${nestedKey}`] = nestedEntry
          } else if (isPlainObject(nestedEntry)) {
            // Font sizes: ["0.75rem", { lineHeight: "1rem" }]
            const lineHeight = nestedEntry.lineHeight

            resolved[`${key}.${nestedKey}`] =
              typeof lineHeight === 'string'
                ? `${nestedEntry as unknown as string} ${lineHeight}`
                : String(nestedEntry)
          }
        }
      }
    }

    resolvedCache.set(field, resolved)

    return resolved
  }

  if (typeof value === 'function') {
    const themeFn: ThemeFn = (key) => resolveThemeField(key)

    try {
      const evaluated = value({
        theme: themeFn,
        colors: resolveThemeField('colors'),
      }) as Record<string, unknown>

      const resolved: Record<string, string | string[]> = {}

      for (const [key, entry] of Object.entries(evaluated)) {
        if (typeof entry === 'string') {
          resolved[key] = entry
        } else if (Array.isArray(entry)) {
          resolved[key] = entry.map((element) => String(element))
        } else {
          resolved[key] = String(entry)
        }
      }

      resolvedCache.set(field, resolved)

      return resolved
    } catch {
      resolvedCache.set(field, {})

      return {}
    }
  }

  resolvedCache.set(field, {})

  return {}
}

export type UtilityField = Record<string, string | string[]>

type UtilityDefinition = {
  prefix: string
  field: string
  description: string
}

/*
 * Utility definitions: keys are CSS-ish prefixes, values are the default
 * theme fields. Documents which prefix pairs with which theme data.
 */
const UTILITY_DEFINITIONS: UtilityDefinition[] = [
  { prefix: 'bg-', field: 'backgroundColor', description: 'Background color' },
  { prefix: 'text-', field: 'fontSize', description: 'Font size' },
  { prefix: 'text-', field: 'textColor', description: 'Text color' },
  { prefix: 'font-', field: 'fontFamily', description: 'Font family' },
  { prefix: 'font-', field: 'fontWeight', description: 'Font weight' },
  { prefix: 'border-', field: 'borderColor', description: 'Border color' },
  { prefix: 'border-', field: 'borderWidth', description: 'Border width' },
  { prefix: 'border-', field: 'borderRadius', description: 'Border radius' },
  { prefix: 'rounded-', field: 'borderRadius', description: 'Border radius' },
  { prefix: 'shadow-', field: 'boxShadow', description: 'Box shadow' },
  { prefix: 'w-', field: 'width', description: 'Width' },
  { prefix: 'h-', field: 'height', description: 'Height' },
  { prefix: 'p-', field: 'padding', description: 'Padding' },
  { prefix: 'px-', field: 'padding', description: 'Padding (x)' },
  { prefix: 'py-', field: 'padding', description: 'Padding (y)' },
  { prefix: 'pt-', field: 'padding', description: 'Padding (top)' },
  { prefix: 'pr-', field: 'padding', description: 'Padding (right)' },
  { prefix: 'pb-', field: 'padding', description: 'Padding (bottom)' },
  { prefix: 'pl-', field: 'padding', description: 'Padding (left)' },
  { prefix: 'm-', field: 'margin', description: 'Margin' },
  { prefix: 'mx-', field: 'margin', description: 'Margin (x)' },
  { prefix: 'my-', field: 'margin', description: 'Margin (y)' },
  { prefix: 'gap-', field: 'gap', description: 'Gap' },
  { prefix: 'gap-x-', field: 'gap', description: 'Column gap' },
  { prefix: 'gap-y-', field: 'gap', description: 'Row gap' },
  { prefix: 'opacity-', field: 'opacity', description: 'Opacity' },
  { prefix: 'z-', field: 'zIndex', description: 'Z-index' },
  { prefix: 'blur-', field: 'blur', description: 'Blur' },
  { prefix: 'brightness-', field: 'brightness', description: 'Brightness' },
  { prefix: 'contrast-', field: 'contrast', description: 'Contrast' },
  { prefix: 'saturate-', field: 'saturate', description: 'Saturation' },
  { prefix: 'grayscale-', field: 'grayscale', description: 'Grayscale' },
  { prefix: 'sepia-', field: 'sepia', description: 'Sepia' },
  { prefix: 'rotate-', field: 'rotate', description: 'Rotate' },
  { prefix: 'scale-', field: 'scale', description: 'Scale' },
  { prefix: 'translate-', field: 'translate', description: 'Translate' },
  { prefix: 'leading-', field: 'lineHeight', description: 'Line height' },
  { prefix: 'tracking-', field: 'letterSpacing', description: 'Letter spacing' },
  { prefix: 'from-', field: 'colors', description: 'Gradient start color' },
  { prefix: 'via-', field: 'colors', description: 'Gradient middle color' },
  { prefix: 'to-', field: 'colors', description: 'Gradient end color' },
  { prefix: 'ring-', field: 'ringColor', description: 'Ring color' },
  { prefix: 'fill-', field: 'fill', description: 'SVG fill' },
  { prefix: 'stroke-', field: 'strokeWidth', description: 'SVG stroke' },
  { prefix: 'accent-', field: 'accentColor', description: 'Accent color' },
  { prefix: 'caret-', field: 'caretColor', description: 'Caret color' },
  { prefix: 'duration-', field: 'transitionDuration', description: 'Transition duration' },
  { prefix: 'basis-', field: 'flexBasis', description: 'Flex basis' },
  { prefix: 'max-w-', field: 'maxWidth', description: 'Max width' },
  { prefix: 'min-w-', field: 'minWidth', description: 'Min width' },
  { prefix: 'max-h-', field: 'maxHeight', description: 'Max height' },
  { prefix: 'min-h-', field: 'minHeight', description: 'Min height' },
  { prefix: 'inset-', field: 'inset', description: 'Inset' },
  { prefix: 'top-', field: 'inset', description: 'Top' },
  { prefix: 'right-', field: 'inset', description: 'Right' },
  { prefix: 'bottom-', field: 'inset', description: 'Bottom' },
  { prefix: 'left-', field: 'inset', description: 'Left' },
  { prefix: 'size-', field: 'size', description: 'Width & height' },
  { prefix: 'columns-', field: 'columns', description: 'Columns' },
  { prefix: 'drop-shadow-', field: 'dropShadow', description: 'Drop shadow' },
]

const VARIANTS = [
  'hover:',
  'focus:',
  'focus-within:',
  'active:',
  'visited:',
  'disabled:',
  'first:',
  'last:',
  'group-hover:',
  'peer-focus:',
  'dark:',
  'sm:',
  'md:',
  'lg:',
  'xl:',
  '2xl:',
]

const STATIC_UTILITIES: string[] = [
  'flex', 'flex-row', 'flex-col', 'flex-wrap', 'flex-nowrap',
  'inline', 'inline-flex', 'block', 'inline-block', 'grid',
  'hidden', 'contents', 'table', 'list-item',
  'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4', 'grid-cols-6',
  'grid-cols-12', 'items-start', 'items-center', 'items-end',
  'items-stretch', 'items-baseline', 'justify-start', 'justify-center',
  'justify-end', 'justify-between', 'justify-around', 'justify-evenly',
  'content-center', 'content-between', 'self-start', 'self-center',
  'self-end', 'self-auto', 'self-stretch', 'grow', 'grow-0', 'shrink',
  'shrink-0', 'order-first', 'order-last', 'order-none',
  'overflow-auto', 'overflow-hidden', 'overflow-visible', 'overflow-scroll',
  'truncate', 'overflow-ellipsis', 'no-underline', 'underline',
  'uppercase', 'lowercase', 'capitalize', 'italic', 'not-italic',
  'normal-case', 'whitespace-normal', 'whitespace-nowrap', 'whitespace-pre',
  'break-normal', 'break-all', 'break-keep', 'break-words',
  'object-contain', 'object-cover', 'object-fill', 'object-none',
  'rounded-none', 'rounded-full', 'pointer-events-none',
  'transition', 'transition-all', 'transition-none', 'transition-colors',
  'transition-opacity', 'transition-transform',
  'ease-in', 'ease-out', 'ease-in-out', 'ease-linear',
  'antialiased', 'subpixel-antialiased', 'isolate', 'visible',
  'fixed', 'absolute', 'relative', 'sticky', 'static',
  'border', 'border-solid', 'border-dashed', 'border-dotted', 'border-double',
  'divide-y', 'divide-x', 'ring', 'ring-0', 'ring-1', 'ring-2', 'ring-4',
  'outline-none', 'shadow-inner', 'filter', 'backdrop-filter',
  'sr-only', 'not-sr-only', 'select-none', 'select-text', 'select-all',
  'resize-none', 'resize-y', 'resize-x', 'resize', 'cursor-pointer',
  'cursor-not-allowed', 'cursor-wait', 'cursor-text', 'cursor-move',
  'cursor-help', 'appearance-none', 'box-border', 'box-content',
  'text-left', 'text-center', 'text-right', 'text-justify',
  'align-baseline', 'align-top', 'align-middle', 'align-bottom',
]

export type TailwindCandidate = {
  className: string
  detail: string
  documentation?: string
}

export function generateCandidates(): TailwindCandidate[] {
  const out: TailwindCandidate[] = [] as TailwindCandidate[]

  const consideredFields = new Set<string>()

  for (const definition of UTILITY_DEFINITIONS) {
    if (consideredFields.has(definition.prefix)) {
      continue
    }

    consideredFields.add(definition.prefix)

    const values = resolveThemeField(definition.field)

    const keys = Object.keys(values)

    for (const key of keys) {
      // Skip x2 fallback keys: duplicates are okay (tags last-write wins).
      const className = `${definition.prefix}${key}`

      const documentation = values[key]

      out.push({
        className,
        detail: definition.description,

        documentation:
          typeof documentation === 'string'
            ? documentation
            : documentation.join(' / '),
      })
    }
  }

  for (const className of STATIC_UTILITIES) {
    out.push({ className, detail: '(static utility)' })
  }

  return out
}

export type VariantCandidate = {
  prefix: string
}

export function generateVariantCandidates(): VariantCandidate[] {
  return VARIANTS.map((prefix) => ({ prefix }))
}

/* For hover: attempt value resolution for a className */
function stripVariants(className: string): string {
  return className.split(':').pop() ?? className
}

function lookupValue(
  className: string,
): { description: string; documentation?: string } | undefined {
  for (const definition of UTILITY_DEFINITIONS) {
    if (!className.startsWith(definition.prefix)) {
      continue
    }

    const suffix = className.slice(definition.prefix.length)

    const values = resolveThemeField(definition.field)
    const value = values[suffix]

    if (value != null) {
      let normalized: string

      if (typeof value === 'string') {
        normalized = value
      } else if (value.length === 1) {
        normalized = value[0]
      } else {
        normalized = value.join(' / ')
      }

      return {
        description: definition.description,
        documentation: `${definition.field} (${suffix}): ${normalized}`,
      }
    }
  }

  return undefined
}

export function getTailwindHoverInfo(
  className: string,
): string | undefined {
  const bare = stripVariants(className)
  const info = lookupValue(bare)

  if (info == null) {
    return undefined
  }

  return info.documentation ?? info.description
}
