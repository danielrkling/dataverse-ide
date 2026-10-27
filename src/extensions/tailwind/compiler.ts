/*
 * Tailwind workspace compiler (IntelliSense-lite generation).
 *
 * 1. Scans workspace sources for class-name usage:
 *      - class="..." / className="..." / class='...' / `class="..."` inside
 *        template literals and plain strings
 * 2. Maps recognized Tailwind v4 candidates to CSS declarations using the
 *    same default-theme data as the completion catalog.
 * 3. Emits a CSS file of generated rules (variants supported for
 *    hover/focus/active and the sm/md/lg/xl/2xl responsive prefixes).
 *
 * Deliberate scope: this is a fast, dependency-free v4 utility subset - the
 * full oxide scanner/JIT engine is not browser-runnable today.
 */

import {
  resolveThemeField,
  generateCandidates,
} from './theme.js'

import type * as vscodeType from 'vscode'

const SCANNABLE_EXTENSIONS =
  /\.(html|htm|vue|svelte|astro|xhtml|ts|tsx|jsx|js|mjs|cjs|md|mdx)$/i

const CLASS_CAPTURE_PATTERNS: RegExp[] = [
  /\bclass(?:Name)?\s*=\s*{?["'`]([^"'`]+)["'`]/g,
  /\bclassName=\{`([^`]+)`\}/g,
]

function raiseFrequencies(
  text: string,
  patterns: RegExp[],
): Map<string, number> {
  const usages = new Map<string, number>()

  for (const pattern of patterns) {
    pattern.lastIndex = 0

    let match: RegExpExecArray | null

    while ((match = pattern.exec(text)) != null) {
      const attribute = match[1]

      for (const token of attribute.split(/\s+/)) {
        const candidate = token.trim()

        if (candidate.length === 0 || candidate.startsWith('$')) {
          continue
        }

        usages.set(
          candidate,
          (usages.get(candidate) ?? 0) + 1,
        )
      }
    }
  }

  return usages
}

async function scanWorkspaceClassUsage(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<Map<string, number>> {
  const uris = await vscode.workspace.findFiles(
    '**/*',
    '{**/node_modules/**,**/.git/**,**/.ide-build/**,**/dist/**,**/out/**}',
    4000,
  )

  const usages = new Map<string, number>()

  for (const uri of uris) {
    if (!SCANNABLE_EXTENSIONS.test(uri.path)) {
      continue
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri)
      const text = new TextDecoder().decode(bytes)

      for (const [candidate, count] of raiseFrequencies(text, CLASS_CAPTURE_PATTERNS)) {
        usages.set(candidate, (usages.get(candidate) ?? 0) + count)
      }
    } catch {
      // unreadable/binary file: skip
    }
  }

  return usages
}

type CssDecl = { property: string; value: string }

const COLOR_UTILITIES_KEY = {
  'bg-': 'background-color',
  'text-': 'color',
  'border-': 'border-color',
  'from-': '--tw-gradient-from',
  'via-': '--tw-gradient-via',
  'to-': '--tw-gradient-to',
  'fill-': 'fill',
  'stroke-': 'stroke',
  'accent-': 'accent-color',
  'caret-': 'caret-color',
  'ring-': '--tw-ring-color',
  'outline-': 'outline-color',
  'decoration-': 'text-decoration-color',
  'divide-': 'border-color',
}

const SPACING_PREFIXES: Record<string, string> = {
  'p-': 'padding',
  'px-': 'padding-left+right',
  'py-': 'padding-top+bottom',
  'pt-': 'padding-top',
  'pr-': 'padding-right',
  'pb-': 'padding-bottom',
  'pl-': 'padding-left',
  'ps-': 'padding-inline-start',
  'pe-': 'padding-inline-end',
  'm-': 'margin',
  'mx-': 'margin-left+right',
  'my-': 'margin-top+bottom',
  'mt-': 'margin-top',
  'mr-': 'margin-right',
  'mb-': 'margin-bottom',
  'ml-': 'margin-left',
  'ms-': 'margin-inline-start',
  'me-': 'margin-inline-end',
  'gap-': 'gap',
  'gap-x-': 'column-gap',
  'gap-y-': 'row-gap',
  'top-': 'top',
  'right-': 'right',
  'bottom-': 'bottom',
  'left-': 'left',
  'basis-': 'flex-basis',
  'inset-': 'inset',
  'w-': 'width',
  'h-': 'height',
  'size-': 'width+height',
  'max-w-': 'max-width',
  'min-w-': 'min-width',
  'max-h-': 'max-height',
  'min-h-': 'min-height',
}

const STATIC_UTILITIES_CSS: Record<string, string> = {
  'contents': 'display: contents',
  'hidden': 'display: none',
  'contents-list': '',
  'flex': 'display: flex',
  'flex-row': 'flex-direction: row',
  'flex-col': 'flex-direction: column',
  'flex-wrap': 'flex-wrap: wrap',
  'flex-nowrap': 'flex-wrap: nowrap',
  'inline': 'display: inline',
  'inline-flex': 'display: inline-flex',
  'block': 'display: block',
  'inline-block': 'display: inline-block',
  'grid': 'display: grid',
  'table': 'display: table',
  'list-item': 'display: list-item',
  'items-start': 'align-items: flex-start',
  'items-center': 'align-items: center',
  'items-end': 'align-items: flex-end',
  'items-stretch': 'align-items: stretch',
  'justify-start': 'justify-content: flex-start',
  'justify-center': 'justify-content: center',
  'justify-end': 'justify-content: flex-end',
  'justify-between': 'justify-content: space-between',
  'justify-around': 'justify-content: space-around',
  'self-start': 'align-self: flex-start',
  'self-center': 'align-self: center',
  'self-end': 'align-self: flex-end',
  'grow': 'flex-grow: 1',
  'grow-0': 'flex-grow: 0',
  'shrink': 'flex-shrink: 1',
  'shrink-0': 'flex-shrink: 0',
  'overflow-auto': 'overflow: auto',
  'overflow-hidden': 'overflow: hidden',
  'overflow-visible': 'overflow: visible',
  'overflow-scroll': 'overflow: scroll',
  'truncate': 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap',
  'underline': 'text-decoration-line: underline',
  'no-underline': 'text-decoration-line: none',
  'uppercase': 'text-transform: uppercase',
  'lowercase': 'text-transform: lowercase',
  'capitalize': 'text-transform: capitalize',
  'italic': 'font-style: italic',
  'not-italic': 'font-style: normal',
  'antialiased': '-webkit-font-smoothing: antialiased',
  'subpixel-antialiased': '-webkit-font-smoothing: auto',
  'select-none': 'user-select: none',
  'select-text': 'user-select: text',
  'select-all': 'user-select: all',
  'pointer-events-none': 'pointer-events: none',
  'sr-only': 'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border-width: 0',
  'border': 'border-width: 1px',
  'border-solid': 'border-style: solid',
  'border-dashed': 'border-style: dashed',
  'border-dotted': 'border-style: dotted',
  'transition': 'transition-property: color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter; transition-duration: 150ms',
  'transition-all': 'transition-property: all; transition-duration: 150ms',
  'transition-none': 'transition-property: none; transition-duration: 0s',
  'cursor-pointer': 'cursor: pointer',
  'cursor-not-allowed': 'cursor: not-allowed',
  'cursor-wait': 'cursor: wait',
  'cursor-text': 'cursor: text',
  'cursor-move': 'cursor: move',
  'cursor-help': 'cursor: help',
  'absolute': 'position: absolute',
  'fixed': 'position: fixed',
  'relative': 'position: relative',
  'static': 'position: static',
  'sticky': 'position: sticky',
  'text-left': 'text-align: left',
  'text-center': 'text-align: center',
  'text-right': 'text-align: right',
  'text-justify': 'text-align: justify',
  'align-baseline': 'vertical-align: baseline',
  'align-top': 'vertical-align: top',
  'align-middle': 'vertical-align: middle',
  'align-bottom': 'vertical-align: bottom',
  'isolate': 'isolation: isolate',
  'visible': 'visibility: visible',
  'outline-none': 'outline: 2px solid transparent; outline-offset: 2px',
}

function stripVariants(
  className: string,
): {
  selectors: string[]
  atRules: string[]
  bare: string
} {
  const selectors: string[] = []
  const atRules: string[] = []

  let bare = className

  const VARIANT_TABLE: Record<string, (suffix: string) => { selector?: string; atRule?: string }> = {
    'hover:': () => ({ selector: ':hover' }),
    'focus:': () => ({ selector: ':focus' }),
    'focus-within:': () => ({ selector: ':focus-within' }),
    'active:': () => ({ selector: ':active' }),
    'first:': () => ({ selector: ':first-child' }),
    'last:': () => ({ selector: ':last-child' }),
    'sm:': () => ({ atRule: '@media (min-width: 40rem)' }),
    'md:': () => ({ atRule: '@media (min-width: 48rem)' }),
    'lg:': () => ({ atRule: '@media (min-width: 64rem)' }),
    'xl:': () => ({ atRule: '@media (min-width: 80rem)' }),
    '2xl:': () => ({ atRule: '@media (min-width: 96rem)' }),
  }

  let guard = 0

  while (guard++ < 10) {
    const colonIndex = bare.indexOf(':')

    if (colonIndex === -1) {
      break
    }

    const variant = bare.slice(0, colonIndex + 1)

    const mapped = VARIANT_TABLE[variant]

    if (mapped == null) {
      break
    }

    const applied = mapped('')

    if (applied.selector != null) {
      selectors.push(applied.selector)
    }

    if (applied.atRule != null) {
      atRules.push(applied.atRule)
    }

    bare = bare.slice(colonIndex + 1)
  }

  return { selectors, atRules, bare }
}

const escapeForSelector = (value: string): string =>
  value
    .replaceAll('.', String.raw`\.`)
    .replaceAll('/', String.raw`\/`)
    .replaceAll('[', String.raw`\[`)
    .replaceAll(']', String.raw`\]`)
    .replaceAll('(', String.raw`\(`)
    .replaceAll(')', String.raw`\)`)
    .replaceAll('%', String.raw`\%`)
    .replaceAll('#', String.raw`\#`)
    .replaceAll(',', String.raw`\,`)
    .replaceAll(':', String.raw`\:`)

function classNameToDeclarations(
  bare: string,
): CssDecl[] | undefined {
  // border-width/border-color/ring-width prefix disambiguation
  const borderWidthValues = resolveThemeField('borderWidth')
  const borderRadiusValues = resolveThemeField('borderRadius')
  const boxShadowValues = resolveThemeField('boxShadow')
  const fontSizeValues = resolveThemeField('fontSize')
  const fontFamilyValues = resolveThemeField('fontFamily')
  const fontWeightValues = resolveThemeField('fontWeight')

  for (const [prefix, property] of Object.entries(COLOR_UTILITIES_KEY)) {
    if (bare.startsWith(prefix)) {
      const suffix = bare.slice(prefix.length)

      if (property.startsWith('--tw-')) {
        // gradient color stops need the full gradient machinery; skip
        return undefined
      }

      const values = resolveThemeField(
        prefix === 'ring-' ? 'ringColor' : 'colors',
      )

      const value = values[suffix]

      if (value != null) {
        return [{ property, value: String(value) }]
      }

      return undefined
    }
  }

  for (const [prefix, property] of Object.entries(SPACING_PREFIXES)) {
    if (!bare.startsWith(prefix) || prefix.length === 0) {
      continue
    }

    const suffix = bare.slice(prefix.length)

    const spacing = resolveThemeField('spacing')
    const value = spacing[suffix]

    if (value == null && !/^[0-9.%(]+$/.test(suffix)) {
      continue
    }

    const resolved =
      value != null ? String(value) : suffix

    const parts = property.split('+') as string[]

    return parts.map(
      (individualProperty) => ({
        property: individualProperty,
        value: resolved,
      }),
    )
  }

  if (bare.startsWith('rounded-')) {
    const value = borderRadiusValues[bare.slice('rounded-'.length)]
    return value != null ? [{ property: 'border-radius', value: String(value) }] : undefined
  }

  if (bare.startsWith('shadow-')) {
    const value = boxShadowValues[bare.slice('shadow-'.length)]
    return value != null ? [{ property: 'box-shadow', value: String(value) }] : undefined
  }

  if (bare.startsWith('text-')) {
    const suffix = bare.slice('text-'.length)
    const fontSize = fontSizeValues[suffix]

    if (fontSize != null) {
      return [{ property: 'font-size', value: String(fontSize) }]
    }

    const colors = resolveThemeField('textColor')
    const color = colors[suffix]
    return color != null ? [{ property: 'color', value: String(color) }] : undefined
  }

  if (bare.startsWith('font-')) {
    const suffix = bare.slice('font-'.length)
    const weight = fontWeightValues[suffix]

    if (weight != null) {
      return [{ property: 'font-weight', value: String(weight) }]
    }

    const family = fontFamilyValues[suffix]

    return family != null ? [{ property: 'font-family', value: String(family) }] : undefined
  }

  if (bare.startsWith('opacity-')) {
    const suffix = bare.slice('opacity-'.length)

    const opacityValues = resolveThemeField('opacity')
    const value = opacityValues[suffix]

    if (value != null) {
      return [{ property: 'opacity', value: String(value) }]
    }

    const numeric = Number(suffix)

    if (!Number.isNaN(numeric)) {
      return [{ property: 'opacity', value: String(numeric / 100) }]
    }

    return undefined
  }

  if (bare.startsWith('z-')) {
    const numeric = Number(bare.slice('z-'.length))
    if (!Number.isNaN(numeric)) {
      return [{ property: 'z-index', value: String(numeric) }]
    }

    return undefined
  }

  const staticCss = STATIC_UTILITIES_CSS[bare]

  if (staticCss != null && staticCss.length > 0) {
    return staticCss
      .split(';')
      .filter((part) => part.trim().length > 0)
      .map((part) => {
        const [property, value] = part.split(':') as [string, string]

        return {
          property: property.trim(),
          value: value.trim(),
        }
      })
  }

  return undefined
}

export function compileClassToCss(className: string): string | undefined {
  const { bare, selectors, atRules } = stripVariants(className)

  const declarations = classNameToDeclarations(bare)

  if (declarations == null || declarations.length === 0) {
    return undefined
  }

  const selectorBase = `.${escapeForSelector(className)}`

  let selector = selectorBase

  for (const variantPart of selectors) {
    selector = `${selector}${variantPart}`
  }

  const declarationBlock = declarations
    .map((d) => `  ${d.property}: ${d.value};`)
    .join('\n')

  let rule = `${selector} {\n${declarationBlock}\n}`

  // responsive variants: wrap in @media (innermost-first)
  for (let index = atRules.length - 1; index >= 0; index--) {
    rule = `${atRules[index]} {\n${ind(rule)}\n}`
  }

  return rule
}

function ind(css: string): string {
  return css
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n')
}
export async function compileTailwindCss(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<string> {
  const usages = await scanWorkspaceClassUsage(vscode, rootUri)

  const knownCandidates = new Set(
    generateCandidates().map((candidate) => candidate.className),
  )

  const rules: string[] = []
  const unmatched: string[] = []

  for (const [className] of [...usages.entries()].sort()) {
    const bareOutput = stripVariants(className)
    const { bare } = bareOutput

    if (!knownCandidates.has(bare) && STATIC_UTILITIES_CSS[bare] == null) {
      unmatched.push(className)
      continue
    }

    const compiled = compileClassToCss(className)

    if (compiled != null) {
      rules.push(compiled)
    } else {
      unmatched.push(className)
    }
  }

  const header =
    '/*\n' +
    ' * Generated by Dataverse IDE Tailwind extension (default-theme subset).\n' +
    ` * ${rules.length} utilities compiled from ${usages.size} used class names.\n` +
    ' */\n\n'

  let body = rules.join('\n\n')

  if (unmatched.length > 0) {
    body += `\n\n/* Unmatched candidates (${unmatched.length}): */\n`

    for (const candidate of unmatched.slice(0, 40)) {
      body += `/* ${candidate} */\n`
    }

    if (unmatched.length > 40) {
      body += `/* â€¦ and ${unmatched.length - 40} more */\n`
    }
  }

  return header + body + '\n'
}

