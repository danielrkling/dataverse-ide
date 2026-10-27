import type * as vscodeType from 'vscode'

import {
  contributeExtensionManifest,
} from '../api.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * Template extension (ported from dataverse-dev-tools' `template`/`inject`
 * command): replace {{path}} placeholders in a file with the contents of
 * the referenced workspace files and write the result.
 *
 *   index.template.html:  <script src="{{dist/app.js}}"></script>
 *   → output:             <script src>"...contents of dist/app.js..."</script>
 *
 * Placeholder paths are workspace-relative (slash separated), resolved
 * with the same extension/index fallbacks as esbuild imports. Replacements
 * happen in template order (concurrency 1 in dev-tools) so the first
 * missing file fails deterministically.
 */

const COMMAND_TEMPLATE = 'dataverseIde.template.inject'

const PLACEHOLDER_PATTERN = /\{\{(.+?)\}\}/g

const RESOLVABLE_EXTENSIONS = [
  '',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json',
  '.html', '.htm', '.txt', '.md', '.svg', '.xml',
]

const INDEX_TRAILS = ['/index.ts', '/index.js', '/index.html']

const DECODER = new TextDecoder()

export default {
  id: 'template',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeExtensionManifest({
      id: 'template',
      displayName: 'Dataverse IDE Template',
      description: 'Inject workspace files into templates via {{path}} placeholders.',
      commands: [
        {
          command: COMMAND_TEMPLATE,
          title: 'Template: Inject Files ({{path}} placeholders)',
        },
      ],
    })

    async function readWorkspaceText(
      path: string,
    ): Promise<string | undefined> {
      const normalized = path
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')

      if (normalized.length === 0) {
        return undefined
      }

      const candidates: string[] = [normalized]

      for (const extension of RESOLVABLE_EXTENSIONS.slice(1)) {
        candidates.push(`${normalized}${extension}`)
      }

      for (const trail of INDEX_TRAILS) {
        candidates.push(`${normalized}${trail}`)
      }

      for (const candidate of candidates) {
        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(context.workspaceRootUri, ...candidate.split('/')),
          )

          return DECODER.decode(bytes)
        } catch {
          // try the next candidate
        }
      }

      return undefined
    }

    async function pickFile(title: string): Promise<vscodeType.Uri | undefined> {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/.git/**,**/node_modules/**,**/.ide-build/**,**/dist/**}',
        2000,
      )

      if (files.length === 0) {
        await vscode.window.showWarningMessage(
          'Template: the workspace has no files to pick from.',
        )

        return undefined
      }

      const items = files
        .map((uri) => ({
          label: vscode.workspace.asRelativePath(uri, false),
          uri,
        }))
        .sort((left, right) => left.label.localeCompare(right.label))

      const selection = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: 'Select a file',
        ignoreFocusOut: true,
      })

      return selection?.uri
    }

    const templateCommand = vscode.commands.registerCommand(
      COMMAND_TEMPLATE,
      async () => {
        /*
         * Template source: the active editor when it holds a text document,
         * a quick pick otherwise.
         */
        let templateUri: vscodeType.Uri | undefined

        const activeEditor = vscode.window.activeTextEditor

        if (
          activeEditor != null &&
          activeEditor.document.uri.scheme === 'file'
        ) {
          templateUri = activeEditor.document.uri
        } else {
          templateUri = await pickFile('Template: select the template file')
        }

        if (templateUri == null) {
          return
        }

        const templatePath = vscode.workspace
          .asRelativePath(templateUri, false)
          .replaceAll('\\', '/')

        const outputUri = await pickFile(
          'Template: select the output file (its content is overwritten)',
        )

        if (outputUri == null) {
          return
        }

        const outputPath = vscode.workspace
          .asRelativePath(outputUri, false)
          .replaceAll('\\', '/')

        try {
          const templateBytes = await vscode.workspace.fs.readFile(templateUri)
          const template = DECODER.decode(templateBytes)

          const matches = [...template.matchAll(PLACEHOLDER_PATTERN)]

          if (matches.length === 0) {
            /*
             * No placeholders: still write the copy so the command behaves
             * like dev-tools' template (a straight file transform).
             */
            await vscode.workspace.fs.writeFile(
              outputUri,
              new TextEncoder().encode(template),
            )

            outputChannel.appendLine(
              `[template] no {{...}} placeholders in ${templatePath}; copied to ${outputPath}.`,
            )

            await vscode.window.showTextDocument(outputUri)

            return
          }

          /*
           * Resolve in template order; the first missing file fails with a
           * clear message and nothing is written.
           */
          const replacements: { placeholder: string; path: string; value: string }[] = []

          for (const match of matches) {
            const path = match[1].trim()

            const value = await readWorkspaceText(path)

            if (value == null) {
              throw new Error(
                `Placeholder {{${path}}} could not be resolved from the workspace (referenced in ${templatePath}).`,
              )
            }

            replacements.push({
              placeholder: match[0],
              path,
              value,
            })
          }

          let result = template

          for (const { placeholder, value } of replacements) {
            /*
             * Function form: literal replacement - "$&" style sequences in
             * the injected content must not be interpreted.
             */
            result = result.replace(placeholder, () => value)
          }

          await vscode.workspace.fs.writeFile(
            outputUri,
            new TextEncoder().encode(result),
          )

          outputChannel.appendLine(
            `[template] injected ${replacements.length} placeholder(s) from ${templatePath} into ${outputPath}.`,
          )

          await vscode.window.showTextDocument(outputUri)

          await vscode.window.showInformationMessage(
            `Template: injected ${replacements.length} file(s) into ${outputPath}.`,
          )
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)

          outputChannel.appendLine(`[template] ${message}`)
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            `Template: ${message}`,
          )
        }
      },
    )

    outputChannel.appendLine('[template] extension activated.')

    return {
      dispose() {
        templateCommand.dispose()
      },
    }
  },
} satisfies IdeExtension
