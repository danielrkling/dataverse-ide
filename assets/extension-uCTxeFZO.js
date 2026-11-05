import{c as j}from"./index-CzwCWkGt.js";import{r as C}from"./guide-DKuydIXd.js";import{c as x}from"./watchStatus-BZHMlqUZ.js";const A=`# Scripts

Run named chains of IDE commands, like \`npm run\` scripts but using command palette commands
instead of shell commands. Steps run in series by default; a step that lists several commands
runs them in parallel.

Use it for repeatable workflows: build, bundle, upload and start watchers in one command.

## Before you start

- Open a workspace (or user settings, for scripts that apply everywhere).
- Know the command ids you want to chain. They are the same ids used by the command palette
  entries, for example \`dataverseIde.esbuild.buildWorkspace\`.
- Scripts run commands **in the IDE**, not in a shell. There is no \`npm run\`, \`git\` CLI or
  arbitrary process execution.

## Quick start

1. Open **Settings** and edit \`dataverseIde.scripts.scripts\`.
2. Define a script:

   \`\`\`json
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
   \`\`\`

3. Run \`Scripts: Run Script\` and pick \`web\`, or run it directly by name from another command.

The status bar shows a running indicator while the script executes. Step-by-step output and
failures are logged in **Output → Dataverse IDE: scripts**.

## Script shape

A script can be a steps array on its own:

\`\`\`json
{
  "dataverseIde.scripts.scripts": {
    "format": ["dataverseIde.prettier.formatDocument"]
  }
}
\`\`\`

or an object with \`steps\` and an optional \`onError\` policy:

\`\`\`json
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
\`\`\`

### Steps

| Step form                              | Meaning                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| \`"command.id"\`                         | Run one command with no arguments.                                                                                |
| \`{ "command.id": [arg1, arg2] }\`       | Run one command; the array is spread as positional arguments. A single non-array value is passed as one argument. |
| \`["command.a", "command.b"]\`           | Run the listed commands **in parallel**; the step completes when all settle.                                      |
| \`{ "command.a": [], "command.b": [] }\` | Same as the array form: multiple keys run in parallel.                                                            |

Nesting is allowed inside a parallel step, so arrays can contain strings and keyed objects.

### Error policy

- \`onError: "abort"\` (default) — stop after the first failed step.
- \`onError: "continue"\` — keep running later steps; the script reports failure at the end.

Parallel steps always run to completion before the policy is applied, even when one command
rejects.

## Recipes

### Build and deploy

\`\`\`json
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
\`\`\`

### Start all watchers

\`\`\`json
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
\`\`\`

### Pass an entry point to a build

\`\`\`json
{
  "dataverseIde.scripts.scripts": {
    "build-app": {
      "steps": [{ "dataverseIde.esbuild.build": ["src/app.tsx"] }]
    }
  }
}
\`\`\`

## Troubleshooting

| Symptom                                       | Cause and fix                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| \`none configured\`                             | The \`dataverseIde.scripts.scripts\` setting is empty or missing.                              |
| \`steps must be command ids…\`                  | A step is not a string, array or keyed object. Check the output channel for the script name. |
| A step fails with "command not found"         | The command id is wrong or its extension is disabled/unavailable.                            |
| Later steps do not run                        | The default \`onError\` is \`abort\`. Set \`"continue"\` if later steps should run regardless.     |
| Script stops halfway through a parallel batch | Parallel steps use \`allSettled\`; all commands finish, then the error policy applies.         |

## Limits

- Commands only — no shell, no pipes, no process spawning.
- No timeouts, retries or conditional steps.
- Arguments are forwarded verbatim; commands that prompt will still prompt.
- The setting is a JSON object, so it can be large but is edited as settings, not a file.
`,w="dataverseIde",I="scripts.scripts",v="dataverseIde.scripts.run";function O(t,e=[]){if(typeof t!="string"||t.trim().length===0)return;const n=Array.isArray(e)?e:[e];return{id:t,args:n}}function S(t){if(typeof t=="string")return t.trim().length===0?void 0:[{id:t,args:[]}];if(Array.isArray(t)){const e=[];for(const n of t){const o=S(n);if(o==null)return;e.push(...o)}return e}if(typeof t=="object"&&t!==null){const e=[];for(const[n,o]of Object.entries(t)){const s=O(n,o);if(s==null||n.trim().length===0)return;e.push(s)}return e.length>0?e:void 0}}function R(t){if(Array.isArray(t)){const n=[];for(const o of t){const s=S(o);if(s==null)return;n.push(s)}return n}const e=S(t);return e==null?void 0:[e]}function D(t){const e={},n=[],s=t.workspace.getConfiguration(w).get(I);if(s==null)return{scripts:e,problems:n};if(typeof s!="object"||Array.isArray(s))return n.push(`${w}.${I} must be an object of named scripts.`),{scripts:e,problems:n};for(const[p,d]of Object.entries(s)){if(p.trim().length===0){n.push("Script names cannot be empty.");continue}let g="abort",a=d;if(typeof d=="object"&&d!==null&&!Array.isArray(d)&&"steps"in d){const i=d;a=i.steps,i.onError==="continue"?g="continue":i.onError!==void 0&&i.onError!=="abort"&&n.push(`Script "${p}": onError must be "abort" or "continue".`)}const r=R(a);if(r==null){n.push(`Script "${p}": steps must be command ids, arrays of command ids, or keyed objects ({ "command": args }).`);continue}e[p]={steps:r,onError:g}}return{scripts:e,problems:n}}function L(t){if(t.args.length===0)return t.id;const e=JSON.stringify(t.args).replaceAll('"',"'");return`${t.id} ${e}`}function y(t){return t.map(L).join(", ")}const G={id:"scripts",async activate(t){const{vscode:e,outputChannel:n}=t,o=C({vscode:e,extensionId:"scripts",content:A});await j({id:"scripts",displayName:"Dataverse IDE Scripts",description:"Run user-defined series/parallel command scripts.",commands:[{command:v,title:"Scripts: Run Script"},{command:"dataverseIde.scripts.openGuide",title:"Scripts: How-to Guide"}],configuration:{title:"Scripts",properties:{[`${w}.${I}`]:{type:"object",default:{},markdownDescription:`Named command scripts (like npm run scripts) that execute other IDE extension commands. A script is a list of steps run in series; a step that is an array runs its commands in parallel. A step can carry arguments as a keyed object whose key is the command id (\`{ "cmd": args }\`); the value spreads as positional arguments to executeCommand. Optional \`onError\` per script: \`abort\` (default) or \`continue\`. Example:

\`\`\`json
"dataverseIde.scripts.scripts": {
  "web": {
    "steps": [
      "dataverseIde.esbuild.buildWorkspace",
      { "dataverseIde.esbuild.build": ["dist/app.js"] },
      [ "dataverseIde.esbuild.startWatch",
        "dataverseIde.tailwind.startWatch",
        "dataverseIde.dataverse.startWatch" ]
    ],
    "onError": "abort"
  }
}
\`\`\``}}}}),n.appendLine("[scripts] extension activated.");let s=!1;const p=x(e,{id:"scripts",label:"script",busyLabel:"Running",priority:90,isRunning:()=>s,start:()=>{e.commands.executeCommand(v)},showOutput:()=>{n.show(!0)},hideWhenStopped:!0});async function d(a,r,i){s=!0,p.update(),n.appendLine(`[scripts] ▶ ${a} (${r.length} step(s), onError: ${i})`);let h=!1,c=!1;for(let l=0;l<r.length;l++){if(c){n.appendLine(`[scripts] ✖ ${a}: aborted at step ${l+1}/${r.length} (onError: abort)`);break}const m=r[l],k=m.length>1,f=y(m);n.appendLine(`[scripts] ${a} step ${l+1}/${r.length}: ${k?`parallel (${f})`:f}`);const E=(await Promise.allSettled(m.map(u=>e.commands.executeCommand(u.id,...u.args)))).filter(u=>u.status==="rejected");for(const u of E){const $=u.reason instanceof Error?u.reason.message:String(u.reason);n.appendLine(`[scripts] ${a} step failed (${f}): ${$}`)}E.length>0&&(h=!0,i==="abort"&&(c=!0))}return h||n.appendLine(`[scripts] ✔ ${a} finished.`),s=!1,p.update(),!h}const g=e.commands.registerCommand(v,async a=>{const{scripts:r,problems:i}=D(e);for(const m of i)n.appendLine(`[scripts] config: ${m}`);i.length>0&&n.show(!0);const h=Object.keys(r);if(h.length===0){n.appendLine("[scripts] no scripts configured; see the dataverseIde.scripts.scripts setting."),await e.window.showInformationMessage('Scripts: none configured. Define scripts under the "dataverseIde.scripts.scripts" setting.');return}let c;if(typeof a=="string"&&r[a]!=null)c=a;else{const m=h.map(f=>{const b=r[f].steps;return{label:`$(run) ${f}`,description:b.length===1?y(b[0]):`${b.length} steps`,detail:b.map(y).join(" → "),name:f}});c=(await e.window.showQuickPick(m,{placeHolder:"Run script",matchOnDescription:!0,matchOnDetail:!0}))?.name}if(c==null)return;const l=r[c];await d(c,l.steps,l.onError??"abort")});return{dispose(){g.dispose(),p.dispose(),o.dispose()}}}};export{G as default};
