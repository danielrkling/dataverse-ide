# Browser Node runtimes and shells — research update (2026-11-23)

Context: the IDE is a static, same-origin Dataverse web resource (Monaco +
monaco-vscode-api, extension host in a worker). We need to run Node scripts and a
command line against the user's workspace with **no server**. This document
compares the current implementation (almostnode shims + custom loader + just-bash)
with the options researched since, including the ones already prototyped
(wcvm, OpenVessel).

## Requirements that actually decide the answer

1. **No backend, no per-user servers.** Everything runs in the tab.
2. **Dataverse hosting.** All assets are web resources (5–16 MB per file,
   `application/x-javascript` MIME for `.js`), the org CSP is outside our control,
   and external CDNs are not a safe assumption for a distributable solution.
3. **A workspace that is a real folder.** Today files are read/written through
   `vscode.workspace.fs` over the File System Access API, with no VFS mirror.
   Any runtime with its own in-memory FS adds a seed + write-back layer.
4. **Synchronous Node APIs.** `require()`, `readFileSync`, `execSync`, and most
   npm tooling assume blocking I/O. Browsers only allow true blocking in a worker
   via `SharedArrayBuffer` (`Atomics.wait`), or against an in-memory VFS.
5. **`.bin` tools.** `npm run` must be able to start `tsc`, `vite`, `eslint`,
   `prettier`, `tailwind`, `esbuild`, etc. — not only `node script.js`.
6. **Distribution.** Licences must allow shipping inside a commercial product,
   and the runtime must not require a vendor account or a hosted service.

## The constraint that changed the calculus: iframe isolation

`SharedArrayBuffer` requires cross-origin isolation. Normally an iframe **cannot**
be isolated if any ancestor is not isolated, and Dataverse embeds web resources in
an iframe inside the model-driven app. The existing service-worker header trick
only works when the document is the top-level page (standalone tab, GitHub Pages
demo); the COOP/COEP headers it adds do not isolate a frame inside a non-isolated
Power Apps page.

**Document-Isolation-Policy (DIP)** is the exception:

- `Document-Isolation-Policy: isolate-and-credentialless` (or
  `isolate-and-require-corp`) on the iframe document makes that document
  cross-origin isolated **on its own**, without requiring the embedder to be
  isolated. Chrome 137+ desktop, Chrome Android 146+; Edge same engine.
  Firefox and Safari do not implement it yet (positions are positive; WebKit is
  tracking implementation).
- The service worker can add the header to the navigation response, just like it
  already adds COOP/COEP, so no Dataverse/DLP change is needed.
- Caveat: the spec is still being aligned (WICG issue #12, Oct 2026) on whether
  cross-origin iframes also need `allow="cross-origin-isolated"` from the
  embedder. Dataverse iframes do not set it. Dataverse web resources are normally
  same-origin with the hosting page, which may avoid the issue, but this must be
  tested in the real app, not assumed.

Consequences:

- **Verify `self.crossOriginIsolated` inside the actual model-driven app iframe**
  with a DIP header added by `sw.js`. If it is `true` in Chrome/Edge, the
  SAB-based runtimes below become viable in the embedded product. If it is
  `false`, only the in-memory-VFS runtimes are viable in the embedded surface
  (and the SAB runtimes are standalone-tab-only).
- Keep a non-SAB fallback regardless: Firefox and Safari will not have DIP for a
  while, and nothing in the SAB class works there.

## Candidates

### Already in use / already tried

| Option                                                                     | What it is                                                                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **almostnode** (MIT, 0.2.14, ~16 MB unpacked)                              | Browser Node compat: 40+ shims, VirtualFS, npm, esbuild-wasm, Vite/Next dev servers, service worker bridge                             | Currently used only for builtin shims. Hand-written shims = fidelity ceiling (crypto, child_process, native addons). No shell of its own (we pair it with just-bash).                                                                                                                                                                                               |
| **wcvm** (ISC, 0.3.4, ~3.3 MB unpacked, ~700 kB gz)                        | Real Node 24 `lib/` on browser bindings; one worker per PID; SAB syscall bridge; npm; OPFS persistence; service-worker preview         | The `wcvm-fs-source` branch already boots it, maps the workspace to `/workspace`, mirrors writes, routes Git through the VFS and adds a wcvm terminal. Gaps: 0.x, custom npm (no lifecycle scripts, workspaces or lockfile), no pty/SIGINT, main-page bridge from the extension host still missing, VFS becomes the source of truth (external disk edits go stale). |
| **OpenVessel** (Apache-2.0, Node 26, runtime tarball from GitHub Releases) | Node's real `lib/` + TS `internalBinding`; kernel worker; processes; shell/coreutils; npm/pnpm/yarn/bun; virtual ports; network policy | Highest fidelity of the "real Node" group. **Hard blocker for us:** it requires three origins (host/runtime/preview) and `boot()` explicitly rejects a host page that is itself in a frame ("the runtime must be embedded directly by the host page"). Only usable if the IDE is opened top-level from domains we control.                                          |

### New in the "real Node, SAB required" group

| Option                                        | Licence / size                                                                  | Why it might matter                                                                                                                                    | Reservations                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vivari** `@vivari/core` 1.3.5               | MIT, ~7.9 MB unpacked                                                           | Node's real `lib/`, real `npm`/`yarn`/`pnpm`, Vite/Next/Astro/Express, CDP step debugger, Bun and Python too. Closest MIT equivalent to WebContainers. | COI via SAB only (`ERR_NOT_ISOLATED`), heavier than wcvm, port rather than drop-in, multi-language features we do not need.                                      |
| **Wasmer SDK / Edge.js** `@wasmer/sdk` 0.19.1 | MIT, ~5.6 MB + registry packages                                                | WASIX sandboxes; Node 24 via Edge.js (QuickJS engine), Python, PHP, Postgres; open source and free. Good if we ever want polyglot.                     | COI + SAB; Node package downloaded from the Wasmer registry at boot (external network/CSP, caching); QuickJS not V8; less proven for arbitrary npm tooling.      |
| **BrowserPod 4**                              | Community Licence (free, attribution), tiny npm wrapper, runtime from their CDN | Real Node 22 compiled to WASM, bash, git, npm; free for commercial use; no account needed.                                                             | Runtime is not self-hostable without Enterprise, served from their CDN → conflicts with Dataverse-only assets/CSP; COI required; attribution.                    |
| **WebContainers**                             | Proprietary; `@webcontainer/api` wrapper is MIT, runtime is not                 | The reference implementation; best-known fidelity.                                                                                                     | Commercial licence for production, 500 sessions/month free tier, API request caps, runtime/CDN outside our control, COI. Not a fit for a distributable solution. |

### New in the "in-memory VFS, no SAB" group

| Option                                      | Licence / size                                          | Why it might matter                                                                                                                                                                                                                                                                                                                                                      | Reservations                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifo** `@lifo-sh/core` 0.10.36            | MIT, ~1.5 MB unpacked                                   | A small Unix-like OS in TypeScript: kernel, VFS, bash-like shell with 60+ commands, processes, ports, npm, Node compat layer, snapshots, IndexedDB persistence, optional `git`/`vi`/`nano`/`less` packages, `WorkerSandbox` for isolation. Boots in tens of ms. Runs Vite/Express/Metro/npm. **No SAB/COI requirement** — works in the embedded iframe on every browser. | Node is a compatibility layer, not Node's real `lib/`; processes share one thread (CPU-bound work blocks the page unless run in `WorkerSandbox`); no native addons except wasm stand-ins; no raw sockets; browser host mounts only via native Node paths, so a browser workspace still needs seed/mirror; shell is bash-like, not bash. |
| **Nodepod** `@r1ck404/nodepod` 1.11.2       | MIT **+ Commons Clause**, ~19.9 MB unpacked, ~600 kB gz | Browser JS engine + 40+ polyfills, worker processes, `child_process`/`worker_threads`, shell with 35+ commands, npm, xterm terminal, snapshots, service-worker preview; fast boot. Works without SAB in reduced mode (sync child-process APIs and threaded WASI unavailable).                                                                                            | Commons Clause restricts selling the runtime itself as a product; 20 MB unpacked; SAB for full behavior; no pty/raw terminal parity in reduced mode. Renamed from `@scelar/nodepod`.                                                                                                                                                    |
| **NodeBrowser** `@foisal/nodebrowser` 1.4.3 | MIT, ~3.4 MB                                            | C/C++ kernel in WASM + QuickJS guest; VFS, processes, npm, WebContainer-shaped API; SAB optional (stdio falls back to polling).                                                                                                                                                                                                                                          | Very small project/community; QuickJS not V8; fidelity/perf risk. Watch, don't adopt.                                                                                                                                                                                                                                                   |

### Full-Linux emulation (last resort)

| Option                    | Notes                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **nano / userland.run**   | RISC-V user-mode Linux in WASM. Real Node 25, BusyBox, npm/tsc/eslint/prettier; slim core ~2.3 MB + signed app catalog installs binaries on demand (full bundle ~68 MB). Runs anywhere (no COI). **AGPL-3.0 core** (SDK MPL-2.0/UEL) — licence blocker for a proprietary distributable IDE; interpreter performance and on-demand downloads are open risks. |
| **v86 / WebVM / CheerpX** | Full x86/Linux or CheerpX VM: real `node`, `git`, `apt`, native binaries. No COI needed. But images are tens of MB (exceeds per-resource limits), boot is seconds and memory is high; workspace mounting needs a 9p/virtio bridge. Overkill unless native binaries become a hard requirement.                                                               |

### Shell / CLI-only options

These do not run Node but could replace or augment just-bash:

| Option                    | Licence / size | Notes                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **just-bash** (current)   | Apache-2.0     | TypeScript bash-like shell, pipes/redirects/globs, in-memory FS adapter, interactive shell. The `.bin` gap is ours to bridge, not just-bash's.                                                                                                                                                        |
| **wasi-sh**               | ISC, ~823 kB   | BusyBox ash + coreutils compiled to wasm32-wasi. Real POSIX-flavoured shell and tools (grep/sed/awk/find/tar/hash), no SAB, in-process. **No processes/fork/exec, no backgrounding or job control, pipelines are sequential**; best for deterministic script execution, not an interactive dev shell. |
| **wasmsh**                | Apache-2.0     | Bash-compatible runtime in Rust/WASM, 88 utilities, VFS, Python via Pyodide, no processes, no network by default. Strong sandbox, but it is a shell sandbox, not Node.                                                                                                                                |
| **uutils coreutils wasm** | MIT            | Real Rust coreutils in WASM with a minimal JS shell. Commands only; no shell language.                                                                                                                                                                                                                |

## Fit matrix

| Option                    | Real Node         | No SAB needed | Fits Dataverse assets/CSP           | npm/.bin                 | Shell included         | Approx. size         | Licence     | Maturity     | Fit now                                        |
| ------------------------- | ----------------- | ------------- | ----------------------------------- | ------------------------ | ---------------------- | -------------------- | ----------- | ------------ | ---------------------------------------------- |
| almostnode (current)      | No (shims)        | Yes           | Yes                                 | Partial (our bridge)     | No                     | 16 MB                | MIT         | Experimental | Baseline                                       |
| just-bash (current shell) | n/a               | Yes           | Yes                                 | No                       | Yes                    | small                | Apache-2.0  | Beta         | Baseline                                       |
| **wcvm**                  | **Yes (Node 24)** | No (SAB)      | Yes (bundled, OPFS)                 | Yes (custom npm)         | Yes (`sh`)             | 3.3 MB               | ISC         | 0.x, active  | **Best full-toolchain fit** (prototype exists) |
| OpenVessel                | Yes (Node 26)     | No (SAB)      | No (3 origins, rejects framed host) | Yes (npm/pnpm/yarn/bun)  | Yes (`sh` + coreutils) | ~6.6 MB lib + kernel | Apache-2.0  | 2.x, new     | No (embedded)                                  |
| **Vivari**                | **Yes**           | No (SAB)      | Yes (bundled)                       | Yes (real npm/yarn/pnpm) | Yes                    | 7.9 MB               | MIT         | 1.x          | Strong MIT alternative                         |
| Wasmer/Edge.js            | Yes-ish (QuickJS) | No (SAB)      | Partial (registry downloads)        | Partial                  | Yes (WASIX)            | 5.6 MB + pkg         | MIT         | 0.x SDK      | Watch / polyglot                               |
| BrowserPod                | Yes (Node 22)     | No (SAB)      | No (CDN runtime)                    | Yes                      | Yes (bash/git)         | CDN                  | Community   | 4.x          | No (distribution)                              |
| WebContainers             | Yes               | No (SAB)      | No (CDN, licence)                   | Yes                      | Yes                    | CDN                  | Proprietary | Mature       | No (cost/licence)                              |
| **Lifo**                  | No (compat layer) | **Yes**       | Yes (bundled)                       | Yes (own npm)            | Yes (60+ cmds)         | 1.5 MB               | MIT         | 0.x, active  | **Best no-SAB upgrade**                        |
| Nodepod                   | No (polyfills)    | Partial       | Yes (bundled)                       | Yes                      | Yes (35+ cmds)         | 19.9 MB              | MIT+Commons | 1.x          | Strong, licence/size caveat                    |
| NodeBrowser               | No (QuickJS)      | Partial       | Yes                                 | Yes                      | ?                      | 3.4 MB               | MIT         | Early        | Watch                                          |
| nano                      | Yes (emulated)    | Yes           | Partial (catalog downloads)         | Yes                      | Yes (BusyBox)          | 2.3 MB + bins        | AGPL        | 0.x          | No (licence/perf)                              |
| wasi-sh / wasmsh          | No                | Yes           | Yes                                 | No                       | Yes                    | <1 MB                | ISC/Apache  | New          | Shell upgrade only                             |

## What the research says

1. **OpenVessel is not a fit for the embedded IDE**, regardless of its quality:
   three origins are required and `boot()` refuses to run from a framed host page.
   It remains the best reference if we ever ship a standalone "full IDE" tab.
2. **wcvm is still the shortest path to a real Node toolchain** and we already have
   a working branch. The remaining work is integration, not research: extension-host
   → main-page bridge, npm lifecycle/workspace gaps, pty behaviour, and deciding
   whether the VFS or the folder is the source of truth.
3. **Lifo is the most interesting new option for the non-SAB path.** It replaces
   almostnode's shims _and_ just-bash with one MIT, 1.5 MB OS that works in any
   embedded iframe, has a real shell, npm, and runs Vite/Express/Metro. The cost is
   the same VFS seed/mirror we already designed for wcvm, and its Node layer is a
   compat layer rather than Node's `lib/`.
4. **DIP is the wildcard.** If `Document-Isolation-Policy` injected by `sw.js`
   makes the embedded Dataverse iframe report `crossOriginIsolated === true` in
   Chrome/Edge, the whole SAB class is back on the table in the real product, and
   we can keep a non-SAB fallback for Firefox/Safari. This is a one-hour spike and
   should be done before choosing a runtime.
5. **Distrust "WebContainer alternative" marketing on size and fidelity.** The
   faithful ones are Node's `lib/` + a native layer + SAB (wcvm/Vivari/OpenVessel);
   the small ones are reimplementations (Lifo/Nodepod/almostnode). Neither group is
   a drop-in for the other.
6. **The `.bin` gap is independent of the runtime.** A bridge that maps
   `node_modules/.bin` entries to the existing `node-runtime` (plus wasm-backed
   replacements for native tools: esbuild-wasm, TypeScript, Tailwind oxide, SWC)
   would unlock `tsc`, `prettier`, `eslint`, parts of `vite` today, without a
   runtime switch. Worth doing either way.

## Recommended decision path

### Step 0 — measure the real hosting constraint (1 hour)

- Add `Document-Isolation-Policy: isolate-and-credentialless` to navigation
  responses in `public/sw.js` (next to COOP/COEP).
- Log `self.crossOriginIsolated`, `typeof SharedArrayBuffer`, and
  `navigator.userAgent` once at boot.
- Open the web resource inside an actual model-driven app page and then as a
  standalone tab; compare. Test Chrome/Edge, Firefox and Safari.
- Pass = `true` embedded in Chromium; then continue to Step 2. Fail = only Step 1
  is available for the embedded product.

### Step 1 — if no embedded SAB: replace the non-SAB stack, don't extend it

- Spike **Lifo** in a branch (mirroring the `wcvm-fs-source` architecture):
  - `Sandbox.create({ files: seedFromFolder })`, `/workspace` as the IDE root,
    VFS provider + write-back watcher, Git via the existing `vscodeGitFs`.
  - Run `node`, `npm install`, `npm run`, `npx tsc`, `vite` through
    `box.commands.run` / `box.spawn`; wire the terminal to `box` (or use
    `WorkerSandbox` + xterm).
  - Measure: boot, 200-file seed, npm install of a small app, `tsc --noEmit`,
    `vite build`, memory, and whether CPU-bound scripts block the workbench.
- Fallback/alternative: **Nodepod reduced mode** if Lifo's Node layer fails on the
  target packages; accept the Commons Clause/size cost only with legal sign-off.
- Keep the current `node-runtime` as the zero-dependency path for single scripts.

### Step 2 — if embedded SAB works: finish the wcvm path, with a fallback

- Keep **wcvm** as the Chromium full-toolchain runtime (already 80% built on
  `wcvm-fs-source`); add **Vivari** as the MIT alternative if wcvm's 0.x npm or
  process gaps block a required workflow.
- Add a runtime capability gate:
  `if (crossOriginIsolated && SharedArrayBuffer) useWcvm(); else useLifo();`
  (or keep `node-runtime` for the fallback) so Firefox/Safari and first loads
  still work.
- Do **not** adopt OpenVessel/BrowserPod/WebContainers for the embedded product
  unless the hosting model changes (three origins / vendor CDN / commercial
  licence respectively).

### Step 3 — cheap wins independent of the choice

- `.bin` resolver for `node_modules/.bin` + shebang handling, wired to
  `node-runtime`; add curated wasm backends for `tsc`, `prettier`, `eslint`,
  `tailwind`, `esbuild`.
- Run the runtime in a dedicated worker (the shell currently runs on the main
  thread; wcvm already does this).
- Add a `node --check`-style capability probe and a visible "runtime: shim /
  real Node" indicator so users know what they are getting.

## Sources

- almostnode — <https://almostnode.dev/>, <https://github.com/macaly/almostnode>
- wcvm — <https://wcvmjs.com/>, <https://docs.wcvmjs.com/architecture>
- OpenVessel — <https://kobesoft.co.jp/oss/openvessel/>, docs `getting-started`
- Vivari — <https://vivari.run/>, <https://github.com/maitrungduc1410/vivari>
- Lifo — <https://lifo.sh/docs>, `@lifo-sh/core`
- Nodepod — <https://github.com/R1ck404/Nodepod>
- Wasmer SDK — <https://docs.wasmer.io/runtime/js/>
- BrowserPod — <https://browserpod.io/pricing>
- WebContainers — <https://webcontainers.io/>
- nano / userland.run — <https://github.com/userland-run/nano>
- NodeBrowser — <https://github.com/foisalislambd/NodeBrowser>
- wasi-sh — <https://github.com/alganet/wasi-sh>
- wasmsh — <https://github.com/mayflower/wasmsh>
- Document-Isolation-Policy — <https://developer.chrome.com/blog/document-isolation-policy>,
  <https://github.com/WICG/document-isolation-policy/issues/12>
- Cross-origin isolation in iframes — <https://blog.stackblitz.com/posts/cross-browser-with-coop-coep/>
