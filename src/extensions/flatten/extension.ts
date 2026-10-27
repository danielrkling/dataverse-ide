import type * as vscodeType from 'vscode'

import {
  contributeExtensionManifest,
} from '../api.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * Flatten extension: combine selected files into a single markdown
 * document (one fenced block per file, path as heading) - useful as LLM
 * context or a quick review bundle.
 *
 * Right-click entries in the file explorer invoke the command with the
 * selected resource URI(s).
 */

const COMMAND_FLATTEN_SELECTED = 'dataverseIde.flatten.selected'

/*
 * Output name; overwritten on every run. Written to the workspace root so
 * it is easy to find and git-track (add to .gitignore if unwanted).
 */
const OUTPUT_FILE_NAME = 'flatten.md'

/*
 * Extensions that are known-decodable as text. Everything else (images,
 * binaries) is skipped with a placeholder note.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'webmanifest',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'xsl',
  'yml', 'yaml', 'csv', 'ini', 'cfg', 'toml', 'env', 'sh', 'bat', 'ps1',
  'resx', 'config',
])

function extensionOf(uri: vscodeType.Uri): string {
  const name = uri.path.split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')

  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function languageTag(uri: vscodeType.Uri): string {
  const extension = extensionOf(uri)

  const aliases: Record<string, string> = {
    htm: 'html',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    jsonc: 'json',
    json5: 'json',
    resx: 'xml',
    config: 'xml',
  }

  return aliases[extension] ?? (extension || '')
}

function fencedBlock(language: string, content: string): string {
  /*
   * Use one more backtick than the longest backtick run inside the content
   * so nested fenced blocks never break the outer fence.
   */
  const longestRun = content.match(/`+/g)?.reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  ) ?? 0

  const fence = '`'.repeat(Math.max(3, longestRun + 1))

  return `${fence}${language}\n${content.replace(/\s+$/, '')}\n${fence}`
}

export default {
  id: 'flatten',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeExtensionManifest({
      id: 'flatten',
      displayName: 'Dataverse IDE Flatten',
      description: 'Combine selected files into a single markdown document.',
      commands: [
        {
          command: COMMAND_FLATTEN_SELECTED,
          title: 'Flatten: Combine Selected Files into Markdown',
        },
      ],
      menus: [
        {
          menu: 'explorer/context',
          command: COMMAND_FLATTEN_SELECTED,
          group: 'dataverse@70',
        },
      ],
    })

    const flattenCommand = vscode.commands.registerCommand(
      COMMAND_FLATTEN_SELECTED,
      async (arg?: vscodeType.Uri | vscodeType.Uri[]) => {
        /*
         * The explorer passes a single URI when one item is selected and an
         * array when several are (or when invoked from the parent of a
         * multi-select).
         */
        const uris = Array.isArray(arg) ? arg : arg != null ? [arg] : []

        if (uris.length === 0) {
          await vscode.window.showWarningMessage(
            'Flatten: select one or more files in the explorer first.',
          )

          return
        }

        const sections: string[] = []
        let included = 0
        let skipped = 0

        for (const uri of uris) {
          const relativePath = vscode.workspace.asRelativePath(uri, false)

          let stat: vscodeType.FileStat

          try {
            stat = await vscode.workspace.fs.stat(uri)
          } catch {
            skipped++
            outputChannel.appendLine(`[flatten] could not stat ${relativePath}`)
            continue
          }

          if (stat.type === vscode.FileType.Directory) {
            /*
             * Include directory selections by flattening their text files
             * recursively.
             */
            const children = await vscode.workspace.findFiles(
              new vscode.RelativePattern(uri, '**/*'),
              '{**/.git/**,**/node_modules/**,**/.ide-build/**,**/dist/**}',
              500,
            )

            for (const child of children) {
              const section = await readSection(vscode, child)

              if (section != null) {
                sections.push(section)
                included++
              } else {
                skipped++
              }
            }

            continue
          }

          const section = await readSection(vscode, uri)

          if (section != null) {
            sections.push(section)
            included++
          } else {
            skipped++
          }
        }

        if (sections.length === 0) {
          await vscode.window.showWarningMessage(
            'Flatten: no readable text files in the selection.',
          )

          return
        }

        const header =
          `# Flattened workspace files\n\n` +
          `Generated ${new Date().toISOString()} — ` +
          `${included} file(s)` +
          (skipped > 0 ? `, ${skipped} skipped (binary or unreadable)` : '') +
          `\n`

        const markdown = `${header}\n${sections.join('\n\n')}\n`

        const outFile = vscode.Uri.joinPath(
          context.workspaceRootUri,
          OUTPUT_FILE_NAME,
        )

        await vscode.workspace.fs.writeFile(
          outFile,
          new TextEncoder().encode(markdown),
        )

        outputChannel.appendLine(
          `[flatten] wrote ${included} file(s) to ${OUTPUT_FILE_NAME}.`,
        )

        await vscode.window.showTextDocument(outFile)
      },
    )

    outputChannel.appendLine('[flatten] extension activated.')

    return {
      dispose() {
        flattenCommand.dispose()
      },
    }
  },
} satisfies IdeExtension

async function readSection(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
): Promise<string | undefined> {
  const relativePath = vscode.workspace.asRelativePath(uri, false)

  if (!TEXT_EXTENSIONS.has(extensionOf(uri))) {
    return `## ${relativePath}\n\n_(binary or unsupported file type - skipped)_`
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    const text = new TextDecoder().decode(bytes)

    return `## ${relativePath}\n\n${fencedBlock(languageTag(uri), text)}`
  } catch {
    return `## ${relativePath}\n\n_(unreadable - skipped)_`
  }
}
