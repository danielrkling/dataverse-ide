import type * as vscodeType from 'vscode'

/*
 * Shared watch status plumbing.
 *
 * Every watch-style extension (esbuild, tailwind, html, dataverse
 * upload) shows a status bar item that stays visible whether its watch is
 * running or stopped, and opens a quick-pick menu on click. This module
 * owns the display/state/menu logic so the extensions cannot drift
 * apart again; each extension only supplies its own lifecycle callbacks.
 */

export type WatchStatusState = 'stopped' | 'running' | 'busy' | 'error'

export interface WatchMenuEntry {
  label: string
  description?: string
  detail?: string
  run: () => unknown
}

export interface WatchStatusOptions {
  /**
   * Namespace part of the auto-registered menu command id
   * (dataverseIde.<id>.watchMenu). Keep it in the extension's own
   * command namespace, e.g. 'esbuild' or 'dataverse'.
   */
  id: string
  /** Short display name shown in the status item, e.g. 'esbuild'. */
  label: string
  /** Text for the busy state, e.g. 'Building' or 'Injecting'. */
  busyLabel?: string
  /** Status bar alignment priority. Defaults to 100 like the old items. */
  priority?: number
  isRunning: () => boolean
  isBusy?: () => boolean
  isError?: () => boolean
  /** Last activity line (single line) for the tooltip. */
  detail?: () => string | undefined
  start?: () => unknown
  stop?: () => unknown
  showOutput?: () => unknown
  openConfig?: () => unknown
  /** Extension-specific menu entries appended before the fixed ones. */
  extraItems?: () => WatchMenuEntry[]
  /**
   * Hide the status item while the watch is stopped (e.g. one-off
   * runners like scripts). Defaults to false: the item always stays
   * visible, dimmed to "$(circle-outline) …: Off".
   */
  hideWhenStopped?: boolean
}

export interface WatchStatus {
  /** Re-evaluate the state from the callbacks and redraw the item. */
  update(): void
  dispose(): void
}

type VSCode = typeof vscodeType

interface QuickPickEntry extends vscodeType.QuickPickItem {
  run: () => unknown
}

/** Hides the status item entirely while state is 'stopped'. */
function isItemHidden(
  state: WatchStatusState,
  options: WatchStatusOptions,
): boolean {
  return options.hideWhenStopped === true && state === 'stopped'
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text
}

export function createWatchStatus(
  vscode: VSCode,
  options: WatchStatusOptions,
): WatchStatus {
  const { id, label } = options
  const busyLabel = options.busyLabel ?? 'Working'
  const priority = options.priority ?? 100

  /*
   * Explicit unique id: without one the workbench keys the status entry by
   * the owning extension, which is shared by every in-house extension
   * (they all use the same bare vscode api). Distinct ids are what make
   * each entry individually hideable from the status bar context menu.
   */
  const item = vscode.window.createStatusBarItem(
    `dataverseIde.${id}.watchStatus`,
    vscode.StatusBarAlignment.Left,
    priority,
  )

  item.name = `${label} Watch`
  const menuCommandId = `dataverseIde.${id}.watchMenu`
  item.command = menuCommandId

  function buildMenu(): QuickPickEntry[] {
    const entries: QuickPickEntry[] = []

    if (options.isRunning() && options.stop != null) {
      entries.push({
        label: `$(stop-circle) Stop ${label} watch`,
        run: options.stop,
      })
    } else if (options.start != null) {
      entries.push({
        label: `$(play-circle) Start ${label} watch`,
        run: options.start,
      })
    }

    if (options.showOutput != null) {
      entries.push({
        label: '$(output) Show output',
        run: options.showOutput,
      })
    }

    if (options.openConfig != null) {
      entries.push({
        label: '$(settings-gear) Open config',
        run: options.openConfig,
      })
    }

    for (const extra of options.extraItems?.() ?? []) {
      entries.push({
        label: extra.label,
        description: extra.description,
        detail: extra.detail,
        run: extra.run,
      })
    }

    return entries
  }

  const menuCommand = vscode.commands.registerCommand(
    menuCommandId,
    async () => {
      const entries = buildMenu()

      const picked = await vscode.window.showQuickPick(entries, {
        placeHolder: `${label} watch`,
        matchOnDescription: true,
        matchOnDetail: true,
      })

      if (picked == null) {
        return
      }

      void picked.run()
    },
  )

  function update(): void {
    let state: WatchStatusState

    if (options.isBusy?.() === true) {
      state = 'busy'
    } else if (options.isError?.() === true) {
      state = 'error'
    } else if (options.isRunning()) {
      state = 'running'
    } else {
      state = 'stopped'
    }

    if (isItemHidden(state, options)) {
      item.hide()
      return
    }

    switch (state) {
      case 'busy':
        item.text = `$(sync~spin) ${label}: ${busyLabel}`
        break
      case 'error':
        item.text = `$(warning) ${label}: Error`
        break
      case 'running':
        item.text = `$(eye) ${label}: Watching`
        break
      default:
        item.text = `$(circle-outline) ${label}: Off`
    }

    const detailLine = options.detail?.()
    const detail =
      detailLine == null || detailLine === ''
        ? undefined
        : firstLine(detailLine)

    const tooltipLines: string[] = [detail ?? ''].filter(
      (line) => line !== '',
    )

    tooltipLines.push(
      state === 'stopped'
        ? `${label} watch is stopped.`
        : `${label} watch is running.`,
    )
    tooltipLines.push('Click for watch options.')

    item.tooltip = tooltipLines.join('\n\n')

    item.show()
  }

  update()

  return {
    update,
    dispose() {
      item.dispose()
      menuCommand.dispose()
    },
  }
}
