# AI Chat

Dataverse IDE ships its own chat harness instead of using the VS Code Chat
service. The **AI Chat** extension provides:

- a **sidebar view** and a **full editor tab** that show the same conversation;
- an agent loop with workspace tools (`read_file`, `write_file`,
  `list_directory`, `create_directory`, `delete_file`, `move_file`,
  `get_file_info`, `search_files`, `open_file`);
- chat history stored in the shared `dataverse-ide` IndexedDB database;
- commands and settings for the endpoint, model, proxy, and API key.

No Copilot sign-in, chat session, or language-model provider is involved.

## Open the chat

- **Ctrl+Alt+I** opens the sidebar view (`AI Chat: Open Chat`).
- **Ctrl+Alt+Shift+I** opens the full editor tab
  (`AI Chat: Open Chat in Editor`).
- The **Dataverse AI** status-bar item and the AI Chat activity-bar icon open
  the sidebar.
- The **⧉** button in the chat header opens the same conversation in an editor
  tab.

Both surfaces subscribe to the same conversation, so they mirror each other.
**＋** starts a new chat; **☰** opens saved chat history.

## Configure an endpoint

The extension works with services that expose an OpenAI-compatible
`/chat/completions` API:

| Service      | Base URL                                                              |
| ------------ | --------------------------------------------------------------------- |
| OpenRouter   | `https://openrouter.ai/api/v1`                                        |
| Groq         | `https://api.groq.com/openai/v1`                                      |
| Ollama       | `http://localhost:11434/v1`                                           |
| LM Studio    | `http://localhost:1234/v1`                                            |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` |

1. Click **⚙** in the chat header (or run **AI Chat: Set API Key**).
2. Set **API base URL** and **Model**.
3. Click **Set API Key** and paste the key. It is stored in the browser's
   secret storage, not in workspace settings.
4. Start typing.

The model setting accepts a comma-separated list; the first entry is used.

### Azure OpenAI

Set **Azure API version** (for example `2024-10-21`) and use the deployment URL
as the base URL. With a version set, the key is sent in the `api-key` header
instead of `Authorization: Bearer`.

### Local endpoints

Local endpoints (localhost, `127.0.0.1`, `*.local`) do not prompt for an API
key. For Ollama, allow the IDE origin via `OLLAMA_ORIGINS` if browser requests
are rejected.

## CORS

The IDE runs entirely in the browser, so the endpoint must allow CORS from the
IDE's origin. Most major providers now do. If `fetch` fails with a CORS/network
error, point **API base URL** at a CORS-enabled gateway or your own proxy.

A browser context also means the API key is visible to the user. For a shared
deployment, proxy requests through a backend that holds the key; for per-user
BYOK setups, direct browser calls are reasonable.

### OpenCode Go

OpenCode Go's inference endpoints (`https://opencode.ai/inference/go/...`)
currently do not answer CORS preflight requests for chat/completions, even
though the `/models` endpoints do. Direct browser use is therefore blocked.
Point **API base URL** at your own proxy that forwards to
`https://opencode.ai/inference/go/openai/v1` (and preserves the
`x-opencode-session` header) if you want to use a Go subscription here.

### Power Automate

A Power Automate flow with a **When an HTTP request is received** trigger is not
a browser-facing proxy on its own:

- the trigger does not return CORS headers, so browsers block direct calls;
- a synchronous **Response** action must finish within 120 seconds;
- the trigger URL contains a SAS signature that should not be exposed in the
  browser;
- there is no SSE streaming, so the flow must force `stream: false` and return
  the provider's JSON response with `Content-Type: application/json`.

Put an Azure Function, API Management, or another server-side proxy in front for
CORS/auth, and have that call the flow or the provider directly.

Set **Proxy URL** to the browser-facing endpoint. The extension sends:

```jsonc
{
  "url": "https://provider.example/v1/chat/completions",
  "method": "POST",
  "headers": {
    "content-type": "application/json",
    "authorization": "Bearer …",
  },
  "body": "{\"model\":\"…\",\"messages\":[…],\"stream\":false}",
}
```

The proxy must forward that request and return the upstream JSON with
`Content-Type: application/json`. Both a raw OpenAI response and a
`{ status, headers, body }` wrapper are accepted. When a proxy is configured,
responses are non-streaming.

## Workspace tools

**Enable workspace tools** is on by default. The agent can call:

- `read_file` — read a UTF-8 text file (up to 256 KB)
- `read_files` — read several files in one call (up to 20 files, 512 KB total)
- `write_file` — create or replace a UTF-8 text file, creating parent folders
- `list_directory` — list a workspace directory; `recursive: true` returns every
  nested path in one call, and `includeIgnored: true` descends into
  `node_modules`, `.git`, `dist`, and similar folders
- `create_directory` — create a folder and missing parents
- `delete_file` — delete a file, or a folder with `recursive: true`
- `move_file` — move or rename a file or folder
- `get_file_info` — type, size, and modified time
- `find_files` — find files and folders by name or glob (`App.tsx`,
  `*.css`, `**/*.tsx`)
- `search_files` — substring or regular-expression content search with line
  numbers; plain-text queries also return path matches
- `open_file` — open a file in the editor and jump to a line

Paths are relative to the workspace root and cannot escape it. **Confirm file
writes** asks before a tool writes, moves, or deletes anything. **Max agent
steps** bounds the model/tool loop (1–60). Tool cards in the transcript show the
arguments and result for each call.

The tools operate on the IDE's mounted workspace (OPFS or File System Access),
not on a Node `workspace/` directory. While tools are enabled, requests are
non-streaming, so the answer appears as the tool loop progresses.

## Chats and history

Every conversation is saved to IndexedDB in the shared `dataverse-ide`
database, under the `chats` object store, scoped to the workspace root. The most
recent conversation is restored on reload. **☰** lists saved chats for the
current workspace; click one to load it into both surfaces, or **✕** to delete
it. Chats are persisted after each turn, so closing the tab does not lose them.

## Context

With **Include active editor** enabled, each request includes the active file
(only the selection, when there is one). **Max context characters** caps the
total context. Set it to `0` to send only the conversation and the prompt.

**Environment context** (`dataverseIde.ai-chat.environmentContext`) is an
optional free-form description of the project the agent is working in, for
example:

```text
React + Vite web resource. Source in src/, builds to dist/.
Uses Tailwind; do not edit node_modules. Deployment target: Dataverse.
```

It is appended to the system prompt together with the workspace root URI, so
the agent does not have to spend tool calls discovering the layout. This is
per-window configuration (put it in workspace settings to keep it with the
project).

## Commands

- **AI Chat: Open Chat** (`Ctrl+Alt+I`)
- **AI Chat: Open Chat in Editor** (`Ctrl+Alt+Shift+I`)
- **AI Chat: New Chat**
- **AI Chat: Set API Key**
- **AI Chat: Clear API Key**
- **AI Chat: Diagnose**
- **AI Chat: Test Connection**
- **AI Chat: How-to Guide**

## Troubleshooting

- **The chat view is missing** — the extension did not activate. Reload the
  window/hard-refresh, check that **Dataverse IDE AI Chat** is enabled under
  Extensions, and inspect the output channel **Dataverse IDE: ai-chat**.
- **`npm run serve` / built app** — that script serves `dist/`, not the live
  source. Run `npm run build`, restart the server, and hard-refresh. The PWA
  service worker can keep serving an old `index.html`; unregister it in
  DevTools → Application → Service Workers, then reload.
- **Diagnostics** — run **AI Chat: Diagnose**. It reports the active session,
  saved-chat count, model, host (not the full endpoint or proxy URL), API-key
  presence, and tool settings. **Test Connection** sends a small request
  through the configured endpoint/proxy without touching the chat transcript.
- **No response / network error** — check the output channel for
  `[ai-chat] Request received`, `[ai-chat] POST …`, and the endpoint error. The
  header shows the model currently in use.
- **A write or delete was blocked** — confirmation dialogs are modal. Approve
  the tool call, or turn off **Confirm file writes** in settings.
- **After deploying to Dataverse** — rebuild and redeploy the web resource; the
  extension is a separate lazy chunk in the build output.

## Limitations

- Responses stream only when workspace tools are disabled and no proxy is
  configured. Tool loops and Power Automate proxies are non-streaming.
- There is no image input, inline diff preview, or automatic retry. Failed
  requests surface the endpoint's error message in the transcript.
- History is scoped per workspace root and is not synced across browsers.
