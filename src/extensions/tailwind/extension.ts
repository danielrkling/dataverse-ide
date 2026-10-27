import type * as vscodeType from 'vscode'

import {
  generateCandidates,
  generateVariantCandidates,
  getTailwindHoverInfo,
} from './theme.js'

import {
  compileTailwindCss,
} from './compiler.js'

import {
  contributeCommandManifest,
} from '../api.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * Tailwind extension: editor IntelliSense over Tailwind v4 utilities.
 *
 * - Class-name completions in HTML/CSS/JS/TS/JSX/TSX from the default theme
 *   data (plain JS; no WASM scanner involved).
 * - Variant prefixes (hover:, md:, dark:, ...) suggested at the start of a
 *   class context.
 * - Hovers show resolved theme values.
 *
 * Runtime class-to-CSS compilation (preview) is a later step that will use
 * @tailwindcss/browser inside an iframe.
 */

const COMPLETION_TRIGGER_CHARACTERS = ['"', "'", ' ', '-', ':', '/']

const SUPPORTED_LANGUAGES = [
  'html',
  'php',
  'css',
  'scss',
  'less',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'vue',
  'svelte',
]

const CLASS_CONTEXT_REGEX =
  /[^\s"'`<>;={}]*$/

/*
 * Detect "inside a class-name string" by scanning the line prefix before the
 * cursor:
 *   - html/vue/svelte: class="…" | class='…' | class=`…`
 *   - js/ts(react): className="…" | className={`…`}
 * The cursor must be inside a currently-open quote of the right pair.
 */
function isInsideClassStringContext(
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): boolean {
  const lineText = document.lineAt(position).text
  const prefix = lineText.slice(0, position.character)

  const openingMatch =
    /(?:\bclass(?:Name)?\s*=\s*)(["'`])([^"'`\\]*)$/.exec(prefix)

  if (openingMatch == null) {
    return false
  }

  const quoteCharacter = openingMatch[1]

  const suffix = lineText.slice(position.character)

  const closingIndex = suffix.indexOf(quoteCharacter)

  const cursorInsideQuotes = closingIndex === -1

  return cursorInsideQuotes
}

function computeReplacementRange(
  vscode: typeof vscodeType,
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): vscodeType.Range {
  const lineText = document.lineAt(position).text
  const startLine = lineText.slice(0, position.character)

  const match = CLASS_CONTEXT_REGEX.exec(startLine)

  const startCharacter = position.character - (match?.[0].length ?? 0)

  return new vscode.Range(
    new vscode.Position(position.line, startCharacter),
    position,
  )
}

export default {
  id: 'tailwind',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    const candidateData = generateCandidates()

    const candidateItems: vscodeType.CompletionItem[] =
      candidateData.map((candidate) => {
        const item = new vscode.CompletionItem(
          candidate.className,
          vscode.CompletionItemKind.EnumMember,
        )

        item.detail = `Tailwind v4 · ${candidate.className}`

        if (candidate.documentation != null) {
          item.documentation = new vscode.MarkdownString(
            `\`${candidate.className}\`\n\n\`${candidate.documentation}\``,
          )
        }

        item.sortText = `0${candidate.className}`

        return item
      })

    const variants = generateVariantCandidates().map((variant) => {
      const item = new vscode.CompletionItem(
        variant.prefix,
        vscode.CompletionItemKind.Keyword,
      )

      item.detail = 'Tailwind v4 variant'

      item.command = {
        command: 'editor.action.triggerSuggest',
        title: 'Suggest variants',
      }

      item.sortText = '1'

      return item
    })

    outputChannel.appendLine(
      `[tailwind] ${candidateData.length} utility candidates from default theme.`,
    )

    const completionProviderDisposable =
      vscode.languages.registerCompletionItemProvider(
        SUPPORTED_LANGUAGES,
        {
          provideCompletionItems(document, position) {
            const wordRange = computeReplacementRange(
              vscode,
              document,
              position,
            )

            const word = document.getText(wordRange)

            /*
             * Only offer completions inside class-name string contexts:
             * after class=/className= inside an opened quote (", ', `).
             * Elsewhere the provider stays silent.
             */
            if (!isInsideClassStringContext(document, position)) {
              return undefined
            }

            /*
             * The workbench filters items against the typed text, so we hand
             * back the full candidate list. Variant suggestions are excluded
             * once a variant is already present (they'd be noise there).
             */
            const alreadyHasVariant = word.includes(':')

            const items: vscodeType.CompletionItem[] = [
              ...candidateItems,
            ]

            if (!alreadyHasVariant) {
              items.push(...variants)
            }

            return new vscode.CompletionList(items, false)
          },
        },
        ...COMPLETION_TRIGGER_CHARACTERS,
      )

    const hoverProviderDisposable = vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGES,
      {
        provideHover(document, position) {
          const wordRange = document.getWordRangeAtPosition(
            position,
            /[A-Za-z0-9_:./[\]<>()%#-]+/,
          )

          if (wordRange == null) {
            return undefined
          }

          const className = document.getText(wordRange)

          const markdown = getTailwindHoverInfo(className)

          if (markdown == null) {
            return undefined
          }

          return new vscode.Hover(
            new vscode.MarkdownString(`**${className}**\n\n${markdown}`),
            wordRange,
          )
        },
      },
    )

    outputChannel.appendLine('[tailwind] providers registered.')

    await contributeCommandManifest({
      id: 'tailwind',
      displayName: 'Dataverse IDE Tailwind',
      description: 'Tailwind v4 IntelliSense + workspace CSS compilation.',
      commands: [
        {
          command: 'dataverseIde.tailwind.compileCss',
          title: 'Tailwind: Compile CSS From Workspace',
        },
      ],
    })

    const compileCommand = vscode.commands.registerCommand(
      'dataverseIde.tailwind.compileCss',
      async () => {
        outputChannel.show(true)
        outputChannel.appendLine('[tailwind] scanning workspace…')

        try {
          const css = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: '[tailwind] compiling CSS…',
              cancellable: false,
            },
            async () => compileTailwindCss(
              vscode,
              context.workspaceRootUri,
            ),
          )

          const outFile = vscode.Uri.joinPath(
            context.workspaceRootUri,
            '.ide-build',
            'tailwind.css',
          )

          await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(context.workspaceRootUri, '.ide-build'),
          )

          await vscode.workspace.fs.writeFile(
            outFile,
            new TextEncoder().encode(css),
          )

          outputChannel.appendLine(
            `[tailwind] wrote ${vscode.workspace.asRelativePath(outFile, false)}`,
          )

          await vscode.window.showTextDocument(outFile)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          outputChannel.appendLine(`[tailwind] compile failed: ${message}`)
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            `[tailwind] compile failed: ${message}`,
          )
        }
      },
    )

    return {
      dispose() {
        compileCommand.dispose()
        completionProviderDisposable.dispose()
        hoverProviderDisposable.dispose()
      },
    }
  },
} satisfies IdeExtension
