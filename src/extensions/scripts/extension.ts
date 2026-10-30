import type * as vscodeType from 'vscode'

import {
  contributeExtensionManifest,
} from '../api.js'

import {
  createWatchStatus,
  type WatchStatus,
} from '../watchStatus.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * Scripts extension: run other IDE extension commands together, driven
 * entirely by a user-authored VS Code setting — nothing is built in.
 *
 *   "dataverseIde.scripts.scripts": {
 *     "web": {
 *       "onError": "abort",
 *       "steps": [
 *         "dataverseIde.esbuild.buildWorkspace",
 *         { "dataverseIde.esbuild.build": ["dist/app.js"] },
 *         [
 *           "dataverseIde.esbuild.startWatch",
 *           { "dataverseIde.dataverse.uploadSelection": "css/main.css" }
 *         ]
 *       ]
 *     }
 *   }
 *
 * Semantics (npm-run-script style):
 *   - A script value is a list of STEPS run in SERIES (top to bottom).
 *   - A step that is an ARRAY runs its commands in PARALLEL (the batch
 *     settles fully before the next series step starts).
 *   - A step can carry arguments as a keyed object whose key is the
 *     command id ({ "cmd": args }). The value spreads as positional
 *     arguments to executeCommand (a non-array value passes as a single
 *     argument). An object with multiple keys is a parallel batch.
 *   - onError controls failure policy per script: 'abort' stops the
 *     remaining series steps after a failed step/batch (default);
 *     'continue' keeps executing.
 *   - Scripts invoke commands by id in the shared vscode.commands
 *     registry, so any extension's public command is usable and no
 *     extension has to know about this one.
 */

const CONFIG_SECTION = 'dataverseIde'
const SETTING_SCRIPTS = 'scripts.scripts'

const COMMAND_RUN = 'dataverseIde.scripts.run'

type ScriptCommand = {
  id: string
  args: unknown[]
}

/*
 * A step is a list of commands: one command → run alone (series);
 * several → run in parallel. Built from strings (`"cmd"`), arrays
 * (`["a", "b"]`), or keyed objects (`{ "cmd": args }`, where multiple
 * keys are a parallel batch).
 */
type ScriptStep = ScriptCommand[]

type ScriptDefinition = {
  steps: ScriptStep[]
  onError?: 'abort' | 'continue'
}

type ParsedScripts = Record<string, ScriptDefinition>

function parseCommand(id: unknown, argsValue: unknown = []): ScriptCommand | undefined {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return undefined
  }

  /*
   * Args value is positional: an array spreads across
   * executeCommand(id, ...args); anything else passes as one argument.
   */
  const args = Array.isArray(argsValue) ? argsValue : [argsValue]

  return { id, args }
}

/** Parses one step entry into a (possibly parallel) command group. */
function parseStep(entry: unknown): ScriptStep | undefined {
  if (typeof entry === 'string') {
    if (entry.trim().length === 0) {
      return undefined
    }

    return [{ id: entry, args: [] }]
  }

  if (Array.isArray(entry)) {
    const group: ScriptCommand[] = []

    for (const command of entry) {
      const parsed = parseStep(command)

      if (parsed == null) {
        return undefined
      }

      group.push(...parsed)
    }

    return group
  }

  if (typeof entry === 'object' && entry !== null) {
    const group: ScriptCommand[] = []

    for (const [id, argsValue] of Object.entries(entry)) {
      const command = parseCommand(id, argsValue)

      if (command == null || id.trim().length === 0) {
        return undefined
      }

      group.push(command)
    }

    return group.length > 0 ? group : undefined
  }

  return undefined
}

/** Parses the steps list from a script value (string, array, or object). */
function parseSteps(value: unknown): ScriptStep[] | undefined {
  if (Array.isArray(value)) {
    const steps: ScriptStep[] = []

    for (const entry of value) {
      const step = parseStep(entry)

      if (step == null) {
        return undefined
      }

      steps.push(step)
    }

    return steps
  }

  const step = parseStep(value)

  return step == null ? undefined : [step]
}

/*
 * Reads the setting. Returns the valid scripts plus a list of problems;
 * invalid entries are surfaced to the user instead of silently dropped.
 */
function readScripts(
  vscode: typeof vscodeType,
): { scripts: ParsedScripts; problems: string[] } {
  const scripts: ParsedScripts = {}
  const problems: string[] = []

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION)
  const raw = config.get<unknown>(SETTING_SCRIPTS)

  if (raw == null) {
    return { scripts, problems }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(
      `${CONFIG_SECTION}.${SETTING_SCRIPTS} must be an object of named scripts.`,
    )

    return { scripts, problems }
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name.trim().length === 0) {
      problems.push('Script names cannot be empty.')
      continue
    }

    let onError: 'abort' | 'continue' = 'abort'
    let stepsValue: unknown = value

    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'steps' in value
    ) {
      const shaped = value as { steps?: unknown; onError?: unknown }

      stepsValue = shaped.steps

      if (shaped.onError === 'continue') {
        onError = 'continue'
      } else if (shaped.onError !== undefined && shaped.onError !== 'abort') {
        problems.push(
          `Script "${name}": onError must be "abort" or "continue".`,
        )
      }
    }

    const steps = parseSteps(stepsValue)

    if (steps == null) {
      problems.push(
        `Script "${name}": steps must be command ids, arrays of command ids, or keyed objects ({ "command": args }).`,
      )
      continue
    }

    scripts[name] = { steps, onError }
  }

  return { scripts, problems }
}

function stepLabel(command: ScriptCommand): string {
  if (command.args.length === 0) {
    return command.id
  }

  const args = JSON.stringify(command.args).replaceAll('"', "'")

  return `${command.id} ${args}`
}

function stepGroupLabel(step: ScriptStep): string {
  return step.map(stepLabel).join(', ')
}

const extension: IdeExtension = {
  id: 'scripts',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeExtensionManifest({
      id: 'scripts',
      displayName: 'Dataverse IDE Scripts',
      description: 'Run user-defined series/parallel command scripts.',
      commands: [
        {
          command: COMMAND_RUN,
          title: 'Scripts: Run Script',
        },
      ],
      configuration: {
        title: 'Scripts',
        properties: {
          [`${CONFIG_SECTION}.${SETTING_SCRIPTS}`]: {
            type: 'object',
            default: {},
            markdownDescription:
              'Named command scripts (like npm run scripts) that execute other IDE ' +
              'extension commands. A script is a list of steps run in series; a step ' +
              'that is an array runs its commands in parallel. A step can carry ' +
              'arguments as a keyed object whose key is the command id ' +
              '(`{ "cmd": args }`); the value spreads as positional arguments to ' +
              'executeCommand. Optional `onError` per script: `abort` (default) or ' +
              '`continue`. Example:\n\n' +
              '```json\n' +
              '"dataverseIde.scripts.scripts": {\n' +
              '  "web": {\n' +
              '    "steps": [\n' +
              '      "dataverseIde.esbuild.buildWorkspace",\n' +
              '      { "dataverseIde.esbuild.build": ["dist/app.js"] },\n' +
              '      [ "dataverseIde.esbuild.startWatch",\n' +
              '        "dataverseIde.tailwind.startWatch",\n' +
              '        "dataverseIde.dataverse.startWatch" ]\n' +
              '    ],\n' +
              '    "onError": "abort"\n' +
              '  }\n' +
              '}\n' +
              '```',
          },
        },
      },
    })

    outputChannel.appendLine('[scripts] extension activated.')

    let running = false

    const status: WatchStatus = createWatchStatus(vscode, {
      id: 'scripts',
      label: 'script',
      busyLabel: 'Running',
      priority: 90,
      isRunning: () => running,
      start: () => {
        void vscode.commands.executeCommand(COMMAND_RUN)
      },
      showOutput: () => {
        outputChannel.show(true)
      },
      hideWhenStopped: true,
    })

    async function runSeries(
      name: string,
      steps: ScriptStep[],
      onError: 'abort' | 'continue',
    ): Promise<boolean> {
      running = true
      status.update()

      outputChannel.appendLine(
        `[scripts] ▶ ${name} (${steps.length} step(s), onError: ${onError})`,
      )

      let failed = false
      let aborted = false

      for (let index = 0; index < steps.length; index++) {
        if (aborted) {
          outputChannel.appendLine(
            `[scripts] ✖ ${name}: aborted at step ${index + 1}/${steps.length} (onError: abort)`,
          )

          break
        }

        const step = steps[index]
        const isBatch = step.length > 1
        const label = stepGroupLabel(step)

        outputChannel.appendLine(
          `[scripts] ${name} step ${index + 1}/${steps.length}: ${isBatch ? `parallel (${label})` : label}`,
        )

        /*
         * Parallel batches always run to completion (allSettled) so the
         * script's abort/continue policy applies after the batch, never
         * mid-batch.
         */
        const results = await Promise.allSettled(
          step.map((command) =>
            vscode.commands.executeCommand(command.id, ...command.args),
          ),
        )

        const failures = results.filter(
          (result) => result.status === 'rejected',
        ) as PromiseRejectedResult[]

        for (const failure of failures) {
          const reason =
            failure.reason instanceof Error
              ? failure.reason.message
              : String(failure.reason)

          outputChannel.appendLine(
            `[scripts] ${name} step failed (${label}): ${reason}`,
          )
        }

        if (failures.length > 0) {
          failed = true

          if (onError === 'abort') {
            aborted = true
          }
        }
      }

      if (!failed) {
        outputChannel.appendLine(`[scripts] ✔ ${name} finished.`)
      }

      running = false
      status.update()

      return !failed
    }

    const runCommand = vscode.commands.registerCommand(
      COMMAND_RUN,
      async (arg?: string | unknown) => {
        const { scripts, problems } = readScripts(vscode)

        for (const problem of problems) {
          outputChannel.appendLine(`[scripts] config: ${problem}`)
        }

        if (problems.length > 0) {
          outputChannel.show(true)
        }

        const names = Object.keys(scripts)

        if (names.length === 0) {
          outputChannel.appendLine(
            '[scripts] no scripts configured; see the dataverseIde.scripts.scripts setting.',
          )

          await vscode.window.showInformationMessage(
            'Scripts: none configured. Define scripts under the "dataverseIde.scripts.scripts" setting.',
          )

          return
        }

        let selected: string | undefined

        if (typeof arg === 'string' && scripts[arg] != null) {
          selected = arg
        } else {
          const entries = names.map((name) => {
            const steps = scripts[name].steps

            return {
              label: `$(run) ${name}`,
              description:
                steps.length === 1
                  ? stepGroupLabel(steps[0])
                  : `${steps.length} steps`,
              detail: steps.map(stepGroupLabel).join(' → '),
              name,
            }
          })

          const picked = await vscode.window.showQuickPick(entries, {
            placeHolder: 'Run script',
            matchOnDescription: true,
            matchOnDetail: true,
          })

          selected = picked?.name
        }

        if (selected == null) {
          return
        }

        const script = scripts[selected]

        await runSeries(
          selected,
          script.steps,
          script.onError ?? 'abort',
        )
      },
    )

    return {
      dispose() {
        runCommand.dispose()
        status.dispose()
      },
    }
  },
} satisfies IdeExtension

export default extension
