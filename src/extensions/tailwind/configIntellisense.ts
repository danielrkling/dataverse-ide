import type * as vscodeType from 'vscode'

/*
 * IntelliSense for tailwind.config.json.
 *
 * There is no JSON-schema machinery wired up in this IDE, so the config
 * file gets the same treatment as class-name completions: scoped language
 * providers.
 *
 * - Key completions (input/output/minify) with documentation, offered in
 *   key positions.
 * - Value completions for boolean-valued keys (minify: true/false).
 * - Hovers on known keys.
 *
 * Only active on documents named tailwind.config.json; every other JSON
 * file is untouched.
 */

const CONFIG_FILE_NAME = 'tailwind.config.json'

type PropertyDoc = {
  key: string
  type: 'string' | 'boolean'
  detail: string
  documentation: string
  defaultValue?: string
}

const PROPERTY_DOCS: PropertyDoc[] = [
  {
    key: 'input',
    type: 'string',
    detail: 'Workspace CSS entry file',
    documentation:
      'Workspace-relative path to the tailwind CSS entry (e.g. `src/tailwind.css`). ' +
      'The file is the single source of truth: it can `@import "tailwindcss"`, define `@theme` blocks, ' +
      '`@plugin`s, and import other workspace stylesheets. ' +
      'If the key is absent, the default input `@import "tailwindcss";` is used.',
  },
  {
    key: 'output',
    type: 'string',
    detail: 'Output CSS file',
    documentation:
      'Workspace-relative path the compiled CSS is written to. ' +
      'Defaults to `dist/tailwind.css`.',
    defaultValue: 'dist/tailwind.css',
  },
  {
    key: 'minify',
    type: 'boolean',
    detail: 'Minify the compiled CSS',
    documentation:
      'Minifies the compiled CSS with the esbuild CSS minifier before writing. ' +
      'Useful when the output feeds an uploaded bundle. Defaults to `false`.',
    defaultValue: 'false',
  },
]

function isConfigDocument(
  document: vscodeType.TextDocument,
): boolean {
  return (
    document.languageId === 'json' &&
    document.uri.path.split('/').pop() === CONFIG_FILE_NAME
  )
}

export function registerConfigIntellisense(
  vscode: typeof vscodeType,
): vscodeType.Disposable {
  const keyItems: vscodeType.CompletionItem[] = PROPERTY_DOCS.map(
    (property) => {
      const item = new vscode.CompletionItem(
        property.key,
        vscode.CompletionItemKind.Property,
      )

      item.detail = `tailwind.config.json · ${property.detail}`

      item.insertText = new vscode.SnippetString(
        property.type === 'boolean'
          ? `${property.key}: ${property.defaultValue ?? 'false'}`
          : `${property.key}: "$0"`,
      )

      item.documentation = new vscode.MarkdownString(
        property.documentation,
      )

      item.sortText = `0${property.key}`

      return item
    },
  )

  const booleanItems = (
    property: PropertyDoc,
  ): vscodeType.CompletionItem[] =>
    ['true', 'false'].map((value) => {
      const item = new vscode.CompletionItem(
        value,
        vscode.CompletionItemKind.Value,
      )

      item.detail = `tailwind.config.json · ${property.key}`

      item.sortText = `0${value}`

      return item
    })

  const completionProviderDisposable =
    vscode.languages.registerCompletionItemProvider(
      'json',
      {
        provideCompletionItems(document, position) {
          if (!isConfigDocument(document)) {
            return undefined
          }

          const lineText = document.lineAt(position).text
          const prefix = lineText.slice(0, position.character)

          /*
           * Value position: `"key": <cursor>` — offer values for the key
           * being set. Keys without enumerated values (paths) get nothing;
           * the editor's normal word completion still applies.
           */
          if (/:\s*(?:"[^"]*)?$/.test(prefix)) {
            const key = /"([^"]+)"\s*:\s*(?:"[^"]*)?$/.exec(prefix)?.[1]

            const property = PROPERTY_DOCS.find(
              (candidate) => candidate.key === key,
            )

            if (property?.type === 'boolean') {
              return new vscode.CompletionList(
                booleanItems(property),
                false,
              )
            }

            return undefined
          }

          /*
           * Key position: offer the full key set. The workbench filters
           * against the typed text, so the whole list is returned.
           */
          return new vscode.CompletionList(keyItems, false)
        },
      },
      '"',
      't',
      'f',
      ' ',
    )

  const hoverProviderDisposable = vscode.languages.registerHoverProvider(
    'json',
    {
      provideHover(document, position) {
        if (!isConfigDocument(document)) {
          return undefined
        }

        const wordRange = document.getWordRangeAtPosition(
          position,
          /[a-zA-Z-]+/,
        )

        if (wordRange == null) {
          return undefined
        }

        const word = document.getText(wordRange)

        const property = PROPERTY_DOCS.find(
          (candidate) => candidate.key === word,
        )

        if (property == null) {
          return undefined
        }

        const markdown = new vscode.MarkdownString(
          `**${property.key}**${property.defaultValue != null ? ` *(default: \`${property.defaultValue}\`)*` : ''}\n\n${property.documentation}`,
        )

        return new vscode.Hover(markdown, wordRange)
      },
    },
  )

  return {
    dispose() {
      completionProviderDisposable.dispose()
      hoverProviderDisposable.dispose()
    },
  }
}
