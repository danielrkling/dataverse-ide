# Scripts

Run named chains of IDE commands, like `npm run` scripts but using command palette commands
instead of shell commands. Steps run in series by default; a step that lists several commands
runs them in parallel.

Use it for repeatable workflows: build, bundle, upload and start watchers in one command.

## Before you start

- Open a workspace (or user settings, for scripts that apply everywhere).
- Know the command ids you want to chain. They are the same ids used by the command palette
  entries, for example `dataverseIde.esbuild.buildWorkspace`.
- Scripts run commands **in the IDE**, not in a shell. There is no `npm run`, `git` CLI or
  arbitrary process execution.

## Quick start

1. Open **Settings** and edit `dataverseIde.scripts.scripts`.
2. Define a script:

   ```json
   {
     "dataverseIde.scripts.scripts": {
       "web": {
         "steps": [
           "dataverseIde.esbuild.buildWorkspace",
           "dataverseIde.dataverse.uploadConfiguredFiles"
         ],
         "onError": "abort"
       }
     }
   }
   ```

3. Run `Scripts: Run Script` and pick `web`, or run it directly by name from another command.

The status bar shows a running indicator while the script executes. Step-by-step output and
failures are logged in **Output → Dataverse IDE: scripts**.

## Script shape

A script can be a steps array on its own:

```json
{
  "dataverseIde.scripts.scripts": {
    "format": ["dataverseIde.prettier.formatDocument"]
  }
}
```

or an object with `steps` and an optional `onError` policy:

```json
{
  "dataverseIde.scripts.scripts": {
    "ship": {
      "steps": [
        "dataverseIde.esbuild.buildWorkspace",
        { "dataverseIde.dataverse.uploadSelection": ["dist/index.html"] }
      ],
      "onError": "continue"
    }
  }
}
```

### Steps

| Step form                              | Meaning                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `"command.id"`                         | Run one command with no arguments.                                                                                |
| `{ "command.id": [arg1, arg2] }`       | Run one command; the array is spread as positional arguments. A single non-array value is passed as one argument. |
| `["command.a", "command.b"]`           | Run the listed commands **in parallel**; the step completes when all settle.                                      |
| `{ "command.a": [], "command.b": [] }` | Same as the array form: multiple keys run in parallel.                                                            |

Nesting is allowed inside a parallel step, so arrays can contain strings and keyed objects.

### Error policy

- `onError: "abort"` (default) — stop after the first failed step.
- `onError: "continue"` — keep running later steps; the script reports failure at the end.

Parallel steps always run to completion before the policy is applied, even when one command
rejects.

## Recipes

### Build and deploy

```json
{
  "dataverseIde.scripts.scripts": {
    "deploy": {
      "steps": [
        "dataverseIde.tailwind.compileCss",
        "dataverseIde.esbuild.buildWorkspace",
        "dataverseIde.dataverse.uploadConfiguredFiles"
      ]
    }
  }
}
```

### Start all watchers

```json
{
  "dataverseIde.scripts.scripts": {
    "watch": {
      "steps": [
        [
          "dataverseIde.esbuild.startWatch",
          "dataverseIde.tailwind.startWatch",
          "dataverseIde.html.startWatch",
          "dataverseIde.dataverse.startWatch"
        ]
      ],
      "onError": "continue"
    }
  }
}
```

### Pass an entry point to a build

```json
{
  "dataverseIde.scripts.scripts": {
    "build-app": {
      "steps": [{ "dataverseIde.esbuild.build": ["src/app.tsx"] }]
    }
  }
}
```

## Troubleshooting

| Symptom                                       | Cause and fix                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `none configured`                             | The `dataverseIde.scripts.scripts` setting is empty or missing.                              |
| `steps must be command ids…`                  | A step is not a string, array or keyed object. Check the output channel for the script name. |
| A step fails with "command not found"         | The command id is wrong or its extension is disabled/unavailable.                            |
| Later steps do not run                        | The default `onError` is `abort`. Set `"continue"` if later steps should run regardless.     |
| Script stops halfway through a parallel batch | Parallel steps use `allSettled`; all commands finish, then the error policy applies.         |

## Limits

- Commands only — no shell, no pipes, no process spawning.
- No timeouts, retries or conditional steps.
- Arguments are forwarded verbatim; commands that prompt will still prompt.
- The setting is a JSON object, so it can be large but is edited as settings, not a file.
