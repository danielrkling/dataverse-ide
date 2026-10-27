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
  configuration?: ConfigurationContribution
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
        ...(input.configuration != null
          ? { configuration: input.configuration }
          : {}),
      },
    },
    ExtensionHostKind.LocalProcess,
  )

  // Force the extension api to initialize so contributions are picked up.
  await getApi()
}

/*
 * Activity bar icons are rendered as CSS masks (alpha channel only, tinted
 * with the theme foreground color), so the default icon must be a
 * glyph-only SVG with a transparent background - an opaque tile renders as
 * a solid block with no visible glyph.
 */
const DEFAULT_ACTIVITYBAR_ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 7h16v13H4V7Z" fill="none" stroke="#fff" stroke-width="1.8"/>' +
    '<path d="M4 7l3-3h10l3 3" fill="none" stroke="#fff" stroke-width="1.8"/>' +
    '</svg>',
  )

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
/*
 * Manifest icon strings are resolved as paths relative to the extension
 * location (extension-file://…/extension/<icon>). A data: URI appended to
 * that scheme is blocked by the browser (CORS: unknown scheme), so the
 * manifest references a relative path and the actual URL — here the data
 * URI itself, which fetch() supports — is registered via registerFileUrl.
 *
 * The registered path must be relative (no leading slash): joinPath() with
 * an absolute fragment would replace the extension location's path and
 * diverge from the path the views extension point computes.
 */
export function activitybarIconPath(id: string): string {
  return `${id}-icon.svg`
}

export type ConfigurationContribution = {
  title: string
  properties: Record<string, unknown>
}

export type MenuContribution =
  | {
      /** Menu id, e.g. "explorer/context". */
      menu: string
      command: string
      /** e.g. "navigation@60". */
      group?: string
      /** Optional clause, e.g. "resourceExtname == .html". */
      when?: string
    }
  | {
      /** Menu id, e.g. "view/item/context". */
      menu: string
      submenu: string
      group?: string
      when?: string
    }

export type SubmenuContribution = {
  id: string
  label: string
  icon?: string
}

export async function contributeExtensionManifest(input: {
  id: string
  displayName: string
  description: string
  commands: {
    command: string
    title: string
    icon?: string
  }[]
  views?: ViewContribution
  configuration?: ConfigurationContribution
  menus?: MenuContribution[]
  submenus?: SubmenuContribution[]
}): Promise<void> {
  const contributes: Record<string, unknown> = {
    commands: input.commands,
  }

  if (input.configuration != null) {
    contributes.configuration = input.configuration
  }

  if (input.menus != null && input.menus.length > 0) {
    const menus: Record<string, unknown[]> = {}
  
    for (const entry of input.menus) {
      const placement: Record<string, unknown> =
        'command' in entry
          ? {
              command: entry.command,
            }
          : {
              submenu: entry.submenu,
            }
  
      if (entry.group != null) {
        placement.group = entry.group
      }
  
      if (entry.when != null) {
        placement.when = entry.when
      }
  
      ;(menus[entry.menu] ??= []).push(placement)
    }
  
    contributes.menus = menus
  }
  
  if (input.submenus != null && input.submenus.length > 0) {
    contributes.submenus = input.submenus
  }

  if (input.views != null) {
    contributes.viewsContainers = {
      activitybar: [
        {
          id: input.views.containerId,
          title: input.views.containerTitle,
          icon: activitybarIconPath(input.id),
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

  const { getApi, registerFileUrl } = registerExtension(
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
        commands: {
          command: string
          title: string
          icon?: string
        }[]
      },
    },
    ExtensionHostKind.LocalProcess,
  )

  if (input.views != null) {
    registerFileUrl(
      activitybarIconPath(input.id),
      input.views.icon ?? DEFAULT_ACTIVITYBAR_ICON,
    )
  }

  // Force the extension api to initialize so contributions are picked up.
  await getApi()
}
