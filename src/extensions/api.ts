import type * as vscodeType from 'vscode'

export type IdeExtensionSecretStore = {
  get: (key: string) => Promise<string | undefined>
  set: (key: string, value: string) => Promise<void>
  remove: (key: string) => Promise<void>
}

export type IdeExtensionHttp = {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export type ExtensionContext = {
  id: string

  vscode: typeof vscodeType

  workspaceRootUri: vscodeType.Uri

  /*
   * Available for local (File System Access API) workspaces; OPFS
   * workspaces may expose a different handle type, so this is optional.
   */
  workspaceDirectoryHandle?: FileSystemDirectoryHandle

  outputChannel: vscodeType.OutputChannel

  secrets: IdeExtensionSecretStore

  http: IdeExtensionHttp
}

export type IdeExtension = {
  id: string

  activate(context: ExtensionContext): Promise<vscodeType.Disposable | void>
}

import {
  ExtensionHostKind,
  registerExtension,
} from '@codingame/monaco-vscode-api/extensions'

/*
 * Contribute command palette entries for an extension.
 *
 * vscode.commands.registerCommand() alone makes a command executable by
 * exact id, but only commands declared via contributes.commands show up in
 * the command palette. This wraps monaco-vscode registerExtension with the
 * contribution manifest.
 */
export async function contributeCommandManifest(input: {
  id: string
  displayName: string
  description: string
  commands: { command: string; title: string }[]
}): Promise<void> {
  const { getApi } = registerExtension(
    {
      name: `dataverse-ide-${input.id}`,
      publisher: 'dataverse-ide',
      version: '0.1.0',
      engines: {
        vscode: '*',
      },
      displayName: input.displayName,
      description: input.description,
      contributes: {
        commands: input.commands,
      },
    },
    ExtensionHostKind.LocalProcess,
  )

  // Force the extension api to initialize so contributions are picked up.
  await getApi()
}

const DEFAULT_ACTIVITYBAR_ICON =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB4PSIzIiB5PSIzIiB3PSIxOCIgaGVpZ2h0PSIxOCIgcng9IjMiIGZpbGw9IiM0ZjZlZGEiLz48L3N2Zz4='

export type ViewContribution = {
  containerId: string
  containerTitle: string
  icon?: string
  views: { id: string; name: string }[]
}

/*
 * Same as contributeCommandManifest, plus sidebar (activity bar) views.
 * The workbench needs the views service override enabled (workbench.ts).
 */
export async function contributeExtensionManifest(input: {
  id: string
  displayName: string
  description: string
  commands: { command: string; title: string }[]
  views?: ViewContribution
}): Promise<void> {
  const contributes: Record<string, unknown> = {
    commands: input.commands,
  }

  if (input.views != null) {
    contributes.viewsContainers = {
      activitybar: [
        {
          id: input.views.containerId,
          title: input.views.containerTitle,
          icon: input.views.icon ?? DEFAULT_ACTIVITYBAR_ICON,
        },
      ],
    }

    contributes.views = {
      [input.views.containerId]: input.views.views.map((view) => ({
        ...view,
        type: 'tree',
      })),
    }
  }

  const { getApi } = registerExtension(
    {
      name: `dataverse-ide-${input.id}`,
      publisher: 'dataverse-ide',
      version: '0.1.0',
      engines: {
        vscode: '*',
      },
      displayName: input.displayName,
      description: input.description,
      contributes: contributes as {
        commands: { command: string; title: string }[]
      },
    },
    ExtensionHostKind.LocalProcess,
  )

  // Force the extension api to initialize so contributions are picked up.
  await getApi()
}
