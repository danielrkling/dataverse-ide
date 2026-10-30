import type * as vscodeType from 'vscode'

import { createPanelIcon, PANEL_GLYPHS, registerExtensionPanel } from './panels.js'
import { extensionEnabled, extensionModules } from './registry.js'

/*
 * Built-in Extensions manager panel.
 *
 * Not a loadable IdeExtension of its own: registerExtensionsPanel is invoked
 * by activateExtensions so the panel always exists. It exposes one boolean
 * toggle per registered extension, persisted to configuration under
 * "dataverseIde.extensions.enable.<id>".
 *
 * Extensions activate during boot, so toggles take effect on the next
 * workbench reload — the panel's primary action triggers that reload.
 */

/** Panel id (config section "dataverseIde.extensions"). */
export const EXTENSIONS_PANEL_ID = 'extensions'

/** Command that reloads the workbench so enable/disable changes apply. */
export const RELOAD_COMMAND = 'dataverseIde.extensions.reload'

export function registerExtensionsPanel(
  vscode: typeof vscodeType,
  workspaceRootUri?: vscodeType.Uri,
): ReturnType<typeof registerExtensionPanel> {
  const settings = Object.keys(extensionModules).map((id) => ({
    type: 'boolean' as const,
    key: `enable.${id}`,
    label: id,
    default: extensionEnabled[id] ?? false,
    description: 'Enabled on the next reload.',
  }))

  const reload = vscode.commands.registerCommand(RELOAD_COMMAND, () => {
    // eslint-disable-next-line no-restricted-globals -- a full page reload is exactly the point here
    location.reload()
  })

  const panel = registerExtensionPanel(vscode, {
    extensionId: EXTENSIONS_PANEL_ID,
    title: 'Extensions',
    icon: createPanelIcon(PANEL_GLYPHS.package),
    description:
      'Enable or disable Dataverse IDE extensions. Changes apply after reload.',
    settings,
    actions: [
      {
        label: 'Reload to apply changes',
        command: RELOAD_COMMAND,
        primary: true,
        tooltip: 'Reloads the workbench so activation changes take effect.',
      },
    ],
    workspaceRootUri,
  })

  return {
    getSetting: (key, defaultValue) => panel.getSetting(key, defaultValue),
    refresh: () => panel.refresh(),
    dispose() {
      panel.dispose()
      reload.dispose()
    },
  }
}
