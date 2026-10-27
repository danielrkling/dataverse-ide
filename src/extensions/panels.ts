import {
  registerCustomView,
  ViewContainerLocation,
} from '@codingame/monaco-vscode-api/service-override/tools/views'

import type * as vscodeType from 'vscode'

/*
 * Extension side panels.
 *
 * Each IDE extension gets its own activity bar container rendered through
 * registerCustomView (monaco-vscode-api), which mounts real DOM inside the
 * view pane. That allows genuine form controls - checkboxes, sliders, input
 * boxes, dropdowns - instead of the previous click-to-edit tree items.
 *
 * Panel settings are stored in the VSCode configuration service under
 * "dataverseIde.<extensionId>", so they persist and can also be read by
 * extension code via vscode.workspace.getConfiguration().
 */

export type PanelSettingDef =
  | {
      type: 'boolean'
      key: string
      label: string
      default: boolean
      description?: string
    }
  | {
      type: 'string'
      key: string
      label: string
      default: string
      description?: string
      placeholder?: string
    }
  | {
      type: 'number'
      key: string
      label: string
      default: number
      min?: number
      max?: number
      step?: number
      integer?: boolean
      description?: string
    }
  | {
      type: 'enum'
      key: string
      label: string
      default: string
      /**
       * Static options. Mutually exclusive with optionsProvider.
       */
      options?: { value: string; label: string }[]
      /**
       * Dynamic options (e.g. fetched from a remote API). The select is
       * populated asynchronously; call ExtensionPanel.refresh() to re-run.
       */
      optionsProvider?: () => Promise<{ value: string; label: string }[]>
      description?: string
    }
  | {
      type: 'stringList'
      key: string
      label: string
      default: string[]
      description?: string
      placeholder?: string
    }

export type PanelActionDef = {
  label: string
  command: string
  args?: unknown[]
  primary?: boolean
  tooltip?: string
}

export type PanelStore = {
  get<T>(key: string, defaultValue: T): T
  set<T>(key: string, value: T): Promise<void>
  /**
   * Subscribe to external changes (e.g. the config file edited in the text
   * editor). Panels re-sync their controls on every emission.
   */
  onChange(listener: () => void): vscodeType.Disposable
}

export type PanelOptions = {
  /** Short extension id, e.g. "esbuild" (not the full "dataverseIde.esbuild"). */
  extensionId: string
  /** Activity bar + view title. */
  title: string
  /** SVG data URI shown on the activity bar (see createPanelIcon). */
  icon: string
  description?: string
  settings?: PanelSettingDef[]
  actions?: PanelActionDef[]
  /** Workspace root for workspace-scoped configuration writes. */
  workspaceRootUri?: vscodeType.Uri
  /**
   * Custom settings store. Default: vscode configuration under
   * dataverseIde.<extensionId>. Use a file-backed store when the settings
   * live in a project file (e.g. esbuild.config.json).
   */
  store?: PanelStore
}

export type ExtensionPanel = {
  /** Read a setting value through the same configuration store. */
  getSetting<T>(key: string, defaultValue: T): T
  /**
   * Re-run dynamic option providers (e.g. after remote data changed).
   */
  refresh(): void
  dispose(): void
}

const STYLE_ID = 'dataverse-ide-panel-styles'

function ensurePanelStyles(): void {
  if (document.getElementById(STYLE_ID) != null) {
    return
  }

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.di-panel {
  padding: 10px 14px 16px;
  font-size: 12px;
  color: var(--vscode-foreground);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
}
.di-panel-description {
  color: var(--vscode-descriptionForeground);
  line-height: 1.45;
  margin: 0;
}
.di-panel-section-title {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--vscode-descriptionForeground);
  margin: 2px 0 0;
}
.di-panel-setting {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.di-panel-setting-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--vscode-foreground);
}
.di-panel-setting-description {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 1.35;
}
.di-panel-input,
.di-panel-select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 2px;
  padding: 4px 6px;
  font-size: 12px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.di-panel-input:focus,
.di-panel-select:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.di-panel-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.di-panel-checkbox {
  accent-color: var(--vscode-checkbox-background);
}
.di-panel-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.di-panel-slider {
  flex: 1;
  accent-color: var(--vscode-slider-background, var(--vscode-focusBorder));
}
.di-panel-slider-value {
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground);
}
.di-panel-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.di-panel-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.di-panel-list-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 2px;
  padding: 2px 6px;
}
.di-panel-list-entry-text {
  flex: 1;
  overflow-wrap: anywhere;
}
.di-panel-list-remove {
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
}
.di-panel-list-remove:hover {
  color: var(--vscode-errorForeground);
}
.di-panel-list-add {
  display: flex;
  gap: 6px;
}
.di-panel-button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-align: center;
}
.di-panel-button:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
.di-panel-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.di-panel-button.primary:hover {
  background: var(--vscode-button-hoverBackground);
}
`

  document.head.append(style)
}

/*
 * Activity bar icons are rendered by the workbench as CSS masks: only the
 * SVG's alpha channel is used, tinted with the theme foreground color.
 * Icons must therefore be glyph-only with a TRANSPARENT background - an
 * opaque tile renders as a solid block with no visible glyph.
 */
export function createPanelIcon(
  glyph: string,
): string {
  const svg =
    `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">` +
    glyph +
    `</svg>`

  // eslint-disable-next-line no-restricted-globals
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

/*
 * 24x24 line/solid glyphs designed to read as silhouettes when masked.
 */
export const PANEL_GLYPHS = {
  package:
    '<path d="M4 8l8-4.5L20 8v8l-8 4.5L4 16V8Z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 8l8 4.5L20 8M12 12.5V20" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>',
  gitBranch:
    '<circle cx="6.5" cy="6.5" r="2.4" fill="#fff"/><circle cx="6.5" cy="17.5" r="2.4" fill="#fff"/><circle cx="17.5" cy="8" r="2.4" fill="#fff"/><path d="M6.5 8.9v6.2M17.5 10.4c0 3.8-4.2 5-9 5.1" fill="none" stroke="#fff" stroke-width="1.6"/>',
  cloud:
    '<path d="M7 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 8.6 3.8 3.8 0 0 1 17.2 18H7Z" fill="#fff"/>',
  zap:
    '<path d="M13.5 3 5 13.5h5L10.5 21 19 10.5h-5L13.5 3Z" fill="#fff"/>',
  play:
    '<path d="M8 5.5v13l10-6.5-10-6.5Z" fill="#fff"/>',
  merge:
    '<circle cx="6" cy="6" r="2.5" fill="#fff"/><circle cx="18" cy="18" r="2.5" fill="#fff"/><path d="M6 8.5V12a6 6 0 0 0 6 6h3.5" fill="none" stroke="#fff" stroke-width="1.8"/>',
  wind:
    '<path d="M4 9h9a2.4 2.4 0 1 0-2.4-2.4M4 13.5h13a2.4 2.4 0 1 1-2.4 2.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  roll:
    '<path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M19 4v4.2h-4.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  box:
    '<path d="M4 7h16v13H4V7Z" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M4 7l3-3h10l3 3" fill="none" stroke="#fff" stroke-width="1.8"/>',
} as const

type ControlSync = () => void

export function registerExtensionPanel(
  vscode: typeof vscodeType,
  options: PanelOptions,
): ExtensionPanel {
  ensurePanelStyles()

  const configSection = `dataverseIde.${options.extensionId}`
  const configTarget = options.workspaceRootUri != null
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global

  const syncs = new Map<string, ControlSync>()
  const refreshHooks: (() => void | Promise<void>)[] = []

  /*
   * Store abstraction: vscode configuration by default, or the caller's
   * custom store (e.g. a project config file).
   */
  const store: PanelStore = options.store ?? {
    get<T>(key: string, defaultValue: T): T {
      const config = vscode.workspace.getConfiguration(
        configSection,
        options.workspaceRootUri ?? null,
      )

      return config.get<T>(key, defaultValue)
    },

    async set<T>(key: string, value: T): Promise<void> {
      await vscode.workspace
        .getConfiguration(configSection, options.workspaceRootUri ?? null)
        .update(key, value, configTarget)
    },

    onChange(listener) {
      return vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(configSection)) {
          listener()
        }
      })
    },
  }

  const readConfig = <T>(key: string, defaultValue: T): T =>
    store.get(key, defaultValue)

  const writeConfig = async <T>(key: string, value: T): Promise<void> =>
    store.set(key, value)

  const panelDisposable = registerCustomView({
    id: `dataverseIde.${options.extensionId}`,
    name: options.title,
    icon: options.icon,
    location: ViewContainerLocation.Sidebar,
    renderBody: (container) => {
      const root = document.createElement('div')
      root.className = 'di-panel'
      container.append(root)

      if (options.description != null) {
        const description = document.createElement('p')
        description.className = 'di-panel-description'
        description.textContent = options.description
        root.append(description)
      }

      const settings = options.settings ?? []

      if (settings.length > 0) {
        const settingsTitle = document.createElement('div')
        settingsTitle.className = 'di-panel-section-title'
        settingsTitle.textContent = 'Settings'
        root.append(settingsTitle)
      }

      for (const setting of settings) {
        const row = document.createElement('div')
        row.className = 'di-panel-setting'

        if (setting.type === 'boolean') {
          const labelRow = document.createElement('label')
          labelRow.className = 'di-panel-label di-panel-checkbox-row'

          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.className = 'di-panel-checkbox'
          checkbox.checked = readConfig(setting.key, setting.default)

          const labelText = document.createElement('span')
          labelText.textContent = setting.label

          labelRow.append(checkbox, labelText)
          row.append(labelRow)

          syncs.set(setting.key, () => {
            checkbox.checked = readConfig(setting.key, setting.default)
          })

          checkbox.addEventListener('change', () => {
            void writeConfig(setting.key, checkbox.checked)
          })
        } else if (setting.type === 'number') {
          const label = document.createElement('label')
          label.className = 'di-panel-setting-label'
          label.textContent = setting.label
          row.append(label)

          const sliderRow = document.createElement('div')
          sliderRow.className = 'di-panel-slider-row'

          const slider = document.createElement('input')
          slider.type = 'range'
          slider.className = 'di-panel-slider'
          slider.min = String(setting.min ?? 0)
          slider.max = String(setting.max ?? 100)
          slider.step = String(setting.step ?? (setting.integer ? 1 : 0.1))
          slider.value = String(readConfig(setting.key, setting.default))

          const valueLabel = document.createElement('span')
          valueLabel.className = 'di-panel-slider-value'
          valueLabel.textContent = slider.value

          sliderRow.append(slider, valueLabel)
          row.append(sliderRow)

          syncs.set(setting.key, () => {
            const value = String(readConfig(setting.key, setting.default))
            slider.value = value
            valueLabel.textContent = value
          })

          slider.addEventListener('input', () => {
            valueLabel.textContent = slider.value
          })

          slider.addEventListener('change', () => {
            const value = setting.integer
              ? Number.parseInt(slider.value, 10)
              : Number.parseFloat(slider.value)

            void writeConfig(setting.key, Number.isNaN(value)
              ? setting.default
              : value)
          })
        } else if (setting.type === 'enum') {
          const label = document.createElement('label')
          label.className = 'di-panel-setting-label'
          label.textContent = setting.label
          row.append(label)

          const select = document.createElement('select')
          select.className = 'di-panel-select'

          const staticOptions = setting.options ?? []

          for (const option of staticOptions) {
            const optionElement = document.createElement('option')
            optionElement.value = option.value
            optionElement.textContent = option.label
            select.append(optionElement)
          }

          select.value = readConfig(setting.key, setting.default)
          row.append(select)

          const applyDynamicOptions = async () => {
            if (setting.optionsProvider == null) {
              return
            }

            select.disabled = true

            let options: { value: string; label: string }[]

            try {
              options = await setting.optionsProvider()
            } catch {
              options = [
                {
                  value: readConfig(setting.key, setting.default),
                  label: '(options unavailable)',
                },
              ]
            }

            select.replaceChildren()

            for (const option of options) {
              const optionElement = document.createElement('option')
              optionElement.value = option.value
              optionElement.textContent = option.label
              select.append(optionElement)
            }

            const current = readConfig(setting.key, setting.default)

            select.value = options.some((option) => option.value === current)
              ? current
              : (options[0]?.value ?? '')

            select.disabled = false
          }

          void applyDynamicOptions()
          refreshHooks.push(applyDynamicOptions)

          syncs.set(setting.key, () => {
            const current = readConfig(setting.key, setting.default)

            const known = setting.optionsProvider == null
              ? staticOptions.some((option) => option.value === current)
              : Array.from(select.options).some(
                  (option) => option.value === current,
                )

            if (known || setting.optionsProvider == null) {
              select.value = current
            }
          })

          select.addEventListener('change', () => {
            void writeConfig(setting.key, select.value)
          })
        } else if (setting.type === 'stringList') {
          const label = document.createElement('label')
          label.className = 'di-panel-setting-label'
          label.textContent = setting.label
          row.append(label)

          const list = document.createElement('div')
          list.className = 'di-panel-list'
          row.append(list)

          const readEntries = (): string[] =>
            readConfig(setting.key, setting.default)

          const renderEntries = () => {
            list.replaceChildren()

            const entries = readEntries()

            for (const [index, entry] of entries.entries()) {
              const entryRow = document.createElement('div')
              entryRow.className = 'di-panel-list-entry'

              const entryText = document.createElement('span')
              entryText.className = 'di-panel-list-entry-text'
              entryText.textContent = entry

              const remove = document.createElement('button')
              remove.type = 'button'
              remove.className = 'di-panel-list-remove'
              remove.textContent = '✕'
              remove.title = `Remove ${entry}`
              remove.setAttribute('aria-label', `Remove ${entry}`)
              remove.addEventListener('click', () => {
                const updated = readEntries()
                updated.splice(index, 1)
                void writeConfig(setting.key, updated)
                renderEntries()
              })

              entryRow.append(entryText, remove)
              list.append(entryRow)
            }
          }

          renderEntries()

          const addRow = document.createElement('div')
          addRow.className = 'di-panel-list-add'

          const addInput = document.createElement('input')
          addInput.type = 'text'
          addInput.className = 'di-panel-input'
          addInput.spellcheck = false
          addInput.placeholder = setting.placeholder ?? 'add entry…'

          const addButton = document.createElement('button')
          addButton.type = 'button'
          addButton.className = 'di-panel-button'
          addButton.textContent = 'Add'
          addButton.addEventListener('click', () => {
            const entry = addInput.value.trim()

            if (entry.length === 0) {
              return
            }

            const updated = readEntries()

            if (!updated.includes(entry)) {
              updated.push(entry)
              void writeConfig(setting.key, updated)
            }

            addInput.value = ''
            renderEntries()
          })

          addInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addButton.click()
            }
          })

          addRow.append(addInput, addButton)
          row.append(addRow)

          syncs.set(setting.key, () => {
            renderEntries()
          })
        } else {
          /*
           * Plain string input.
           */
          const label = document.createElement('label')
          label.className = 'di-panel-setting-label'
          label.textContent = setting.label
          row.append(label)

          const input = document.createElement('input')
          input.type = 'text'
          input.className = 'di-panel-input'
          input.spellcheck = false
          input.value = readConfig(setting.key, setting.default)
          input.placeholder = setting.placeholder ?? ''

          row.append(input)

          syncs.set(setting.key, () => {
            const value = readConfig(setting.key, setting.default)

            if (document.activeElement !== input) {
              input.value = value
            }
          })

          const commit = () => {
            void writeConfig(setting.key, input.value.trim())
          }

          input.addEventListener('change', commit)
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              input.blur()
              commit()
            }
          })
        }

        if (setting.description != null) {
          const description = document.createElement('div')
          description.className = 'di-panel-setting-description'
          description.textContent = setting.description
          row.append(description)
        }

        root.append(row)
      }

      const actions = options.actions ?? []

      if (actions.length > 0) {
        const actionsTitle = document.createElement('div')
        actionsTitle.className = 'di-panel-section-title'
        actionsTitle.textContent = 'Actions'
        root.append(actionsTitle)

        const actionsRow = document.createElement('div')
        actionsRow.className = 'di-panel-actions'
        root.append(actionsRow)

        for (const action of actions) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = action.primary
            ? 'di-panel-button primary'
            : 'di-panel-button'
          button.textContent = action.label

          if (action.tooltip != null) {
            button.title = action.tooltip
          }

          button.addEventListener('click', () => {
            void vscode.commands.executeCommand(
              action.command,
              ...(action.args ?? []),
            )
          })

          actionsRow.append(button)
        }
      }

      const storeWatcher = store.onChange(() => {
        for (const sync of syncs.values()) {
          sync()
        }

        for (const hook of refreshHooks) {
          void hook()
        }
      })

      return {
        dispose() {
          storeWatcher.dispose()
          root.remove()
        },
      }
    },
  })

  return {
    getSetting<T>(key: string, defaultValue: T): T {
      return readConfig(key, defaultValue)
    },

    refresh() {
      for (const hook of refreshHooks) {
        void hook()
      }
    },

    dispose() {
      panelDisposable.dispose()
      syncs.clear()
      refreshHooks.length = 0
    },
  }
}
