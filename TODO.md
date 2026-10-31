# Overall

- Able to persist node_modules differently due to onedrive flagging .js files?
- can we persist node_modules differently?

# Extension panel to enable or disabled extensions

- ability to add manual vsix files

# NPM

- [fixed] When package.json doesnt exist on npm install, it creates one but then doesnt install the package after.
  - Cause: creating the starter package.json then awaited `showInformationMessage`, blocking the install flow (and other FS init).
  - Fix: `ensureWorkspacePackageJson` no longer blocks (`packageBridge.ts`), error-code detection made robust via `isFileNotFound`.
- [implemented] our own package.json/registry logic (see src/extensions/npm/):
  - `resolver.ts` - own dependency-tree resolution (replaces almostnode's hardcoded `resolveDependencies`, which rejected ranges like `seroval@^1.0` shipped by real packages).
  - `dataversePackageManager.ts` - PackageManager subclass overriding `install` and `installFromPackageJson` to use the own resolver while reusing almostnode for tarball download/extract/save.
  - semver range matching delegates to the `semver` npm package (now a direct dependency, verified against the cases below) instead of a hand-rolled module; `tests/semver.sanity.mts` pins the behaviour so semver upgrades stay safe.
  - `tests/semver.sanity.mts`, `tests/resolver.sanity.mts` - manual sanity harnesses (run with `node --experimental-strip-types`).
- [verified] resolving @solidjs/web@2.0.0-rc.19 sorts improperly and matches 9 - quick-pick sorting now uses semver's `rsort`.
- [added] npm: Prune Extraneous Packages (`dataverseIde.npm.prune`) - removes top-level node_modules packages not declared in package.json and not required transitively (closure-aware so flat-installed transitive deps survive); modal confirmation, flags corrupt no-package.json installs, syncs node_modules/.package-lock.json.
- [refactored] reduced redundancy between Install / Add Dependency / Add Dev Dependency (single prompt helper, shared section/error/output-channel helpers); fixed Update All moving devDependencies into dependencies (now grouped per section).
- [fixed] build version in dataverse silently failing/stalling with @solidjs/web install - was almostnode's resolver throwing on partial ranges; own resolver (semver package) handles it (live-tested against registry.npmjs.org).
- [fixed] resolving @solidjs/web@2.0.0-rc.19 sorts improperly and matches 9 - previous quick-pick sort coerced prerelease ids through `Number()` (NaN + localeCompare); replaced with `sortVersionsDescending`.

# Solid JS toolchain

## [added 2026-10-31] Solid Babel compilers as an esbuild plugin (`solid: "v1" | "v2"`)

- New `src/extensions/esbuild/solidPlugin.ts`: a real esbuild plugin (registered before the
  workspace-fs plugin, so it owns workspace `.jsx`/`.tsx` onLoad and everything else falls
  through) plus `compileSolidSource()` for reuse.
  - `v2` -> `@solidjs/babel-plugin` (Solid 2.x; renamed from `babel-preset-solid`, which ended
    at 2.0.0-rc.2). `v1` -> `babel-preset-solid@1.9.x` (Solid 1.x). Both loaded lazily;
    `@babel/preset-typescript` strips TS for `.ts/.tsx` (the Solid 2 plugin does not do it).
  - Pure JS: no `@solidjs/compiler-wasm32-wasi`, no WASI pools/glue patches, no worker boot,
    and it works on the main thread (where esbuild now runs) and in any worker.
  - Babel errors are returned as esbuild `errors` with `[solid:vN]` prefixes; `loc` is
    forwarded when Babel provides it (syntax errors), Babel's duplicated absolute filename
    prefix is stripped.
  - Source maps chain: Babel's map is embedded as an inline data URL in the onLoad contents,
    which esbuild consumes -> real `.js.map` with original TSX + `sourcesContent` (the old
    wasm/rolldown path skipped maps).
- Config/plumbing: `esbuild.config.json` `solid: "off" | "v1" | "v2"` (default off; written by
  `updateEsbuildConfig`), `BuildRequest.solid` / `BuildRequestInput.solid`, quick pick
  `esbuild: Solid Compiler…` (`dataverseIde.esbuild.configureSolid`), JSON-schema description.
  The plugin is only added when solid !== off, so existing builds are unchanged.
- Tagged-JSX composition: when both are enabled, the plugin's `beforeTransform` runs the
  existing tagged-JSX transform first (`toJsx` introduces JSX for Solid to compile; `toTagged`
  removes it first). `.ts`/`.js` tagged-JSX files still go through the workspace plugin.
- Browser bundling: `@babel/core` needs Node's `path`; Vite aliases `^path$` ->
  `path-browserify` (otherwise it externalizes an empty object and Babel breaks at runtime).
  `assert`/`util`/`process` resolve to the installed browser packages. Lazy Babel chunks:
  @babel/core ~954 KB, @solidjs/babel-plugin ~278 KB, assert ~310 KB (minified, before gzip).
  `optimizeDeps.include` lists the four Babel packages so the dev optimizer does not reload
  mid-first-build.
- Deps added: `@babel/core`, `@babel/preset-typescript`, `@solidjs/babel-plugin@2.0.0-rc.20`,
  `babel-preset-solid@1.9.16`, `path-browserify`, `assert`, `process`; dev: `@types/babel__core`,
  `esbuild` (sanity harness). Ambient typings in `src/types/solidCompiler.d.ts`.
- Verified: `tsc` + `npm run build` pass; `npx vite optimize --force` prebundles all four;
  `tests/esbuildSolid.sanity.mts` (real esbuild + real Babel) passes v2, v1, source-map chaining,
  and v2 error attribution.
- Open: manual in-browser build of a Solid workspace (v1 + v2) through `esbuild: Build Current
File`; `.tsrx` is intentionally not routed (needs `@tsrx/core` + Node >=22.12); the v2 path
  does not yet run `@solidjs/compiler`'s primitive `sourceNames` pass (JSX-level names still
  come from Babel's `dev` option, currently off); rolldown/rollup/node-runtime still use their
  own paths (the plugin factory is reusable there next). Keep the pinned
  `@solidjs/babel-plugin` rc aligned with the Solid 2 rc a workspace installs - compiled output
  targets the matching `@solidjs/web` helpers.

## [reverted 2026-10-29] in-worker integration rolled back

- The esbuild-worker Solid integration (loader transform, config key, auto-detection, vite glue
  inliner for @solidjs/compiler-wasm32-wasi) was removed after repeated instability
  ("worker error: unknown error" on the #test workspace - see the fix note below for the pool
  theory; the failure persisted across fixes, cause not fully isolated).
- Prototype results below stay valid (node scratch tests, tests/solid2/). A future attempt should
  probably go through its own dedicated worker (like the rolldown one) instead of piggybacking on
  the esbuild worker, with the glue loaded in a fresh module graph.
- Kept: `dataverseIde.esbuild.buildWorkspace` registration fix; improved esbuild worker error
  reporting in buildRunner (event.error stack + messageerror). These are orthogonal.

## [re-fixed 2026-10-29] esbuild worker: lazy resolution never fetched package-internal relative imports

- Re-applied today: BOTH fixes below were still lost from worker.ts - the
  "in-worker integration rolled back" revert took the whole file (including
  these resolution fixes) with it. Live symptom on the #test workspace
  (manifests-only collection, 0 node_modules files in the map): relative
  imports from fetched package files ("./core/error.js" etc. from
  @solidjs/signals/dist/prod/index.js) hit the onResolve relative fallthrough
  which returned a bare relative path -> fatal
  "Plugin "dataverse-ide-virtual-fs" returned a non-absolute path" x29, again
  exactly one round before the joined-path probe would have asked for the
  real sibling file.
- worker.ts now: (1) missingProbeCandidates(joined) probes the
  importer-joined path, (2) the relative fallthrough returns
  { path: joined, external: true } (non-fatal) and only reports a warning for
  truly skipped relative imports ("... was not found in the virtual
  filesystem and was left external"). Note: a relative fallthrough warning
  can natter for genuinely missing files; intermediate probe rounds produce
  no user-visible output anyway.
- TODO tested only via tsc + vite build; re-run tests/solid2/replica.mjs-style
  worker-pipeline replica (tests/ - see original verification notes below)
  and/or manually rebuild the #test workspace to confirm.

## [fixed 2026-10-29] esbuild worker: lazy resolution never fetched package-internal relative imports

- Symptom: "Plugin "dataverse-ide-virtual-fs" returned a non-absolute path: ./core/error.js" x29
  when bundling @solidjs/signals (any package shipping an _unbundled_ dist tree that imports its
  own files relatively).
- Root cause (three stacked pre-existing bugs, esbuild/worker.ts):
  1. `missingProbeCandidates(args.path)` probed the raw specifier ("./core/error.js") against the
     workspace root, so the lazy-request loop read garbage paths ("core/error.js", etc. - the
     "read 1 of 20" pattern) and never asked for the real file
     (node_modules/@solidjs/signals/dist/prod/core/error.js). FIX: probe the importer-joined path.
  2. The relative-branch fallthrough returned `{ path: args.path }` - a bare relative path with no
     namespace in the virtual namespace - which esbuild rejects _fatally_ (whole build throws).
     Unlike the bare-import fallthrough (external: true, non-fatal), this destroyed the pending
     needFiles probe list in the SAME build, so the lazy loop died exactly one round before the
     joined-path probe (fix 1) would have surfaced. FIX: fallthrough returns
     `{ path: joined, external: true }` and records a warning; the next probe round then fetches
     the real sibling file and the import binds normally.
  3. Combined effect mimicked "readable but never fetched": package barrel files arrived via
     bare-import probes (rounds 2/4/6 read @solidjs/web/dist/web.js, solid-js dist files,
     signals dist/prod/index.js) while every relative sibling stayed unread.
- Verified with tests/solid2/replica.mjs (worker-pipeline replica, manifests-only collection +
  lazy rounds over a scratch workspace with @solidjs/web+solid-js+@solidjs/signals): 5 rounds,
  then single 155 KB bundle, zero unresolved imports, zero non-absolute errors.
- Worker pipeline version stamps: .2 = probe fix (1); .3 = non-fatal relative fallthrough (2).

## [fixed 2026-10-29] tailwind @plugin bundling: "produced no output" on probe rounds

- Symptom: `[tailwind] Compile failed: Bundling tailwind module "__tailwind-plugin-entry__.mjs"
produced no output.` when the file map lacks node_modules contents (overlay-FS workspaces where
  `findFiles('node_modules/**')` cannot see files).
- Cause: tailwind's `bundleAndImportModule` called `runner.build()` ONCE. On a lazy-resolution
  probe round the worker answers `{ ok: true, outputs: [], needFiles: [...] }` — which looks
  exactly like "bundle produced no .js output" to a single-shot caller.
- Fix: extracted the lazy probe loop shared with the esbuild extension into
  `src/extensions/esbuild/lazyBuild.ts` (`lazyBuild()`), and tailwind's
  `bundleAndImportModule` now uses it (with optional diagnostics output channel).
- Follow-up: esbuild extension's `runBuild` has its own copy of the loop (with richer logging);
  unify both onto `lazyBuild` once stabilized.

## [fixed] `dataverseIde.esbuild.buildWorkspace` never registerable (2026-10-29)

- Pre-existing bug since the initial extension import (fd10138): the command was contributed in
  `contributeExtensionManifest` but never passed to `vscode.commands.registerCommand`, so invoking
  it always failed with "command not found". Not related to the Solid toolchain change.
- Now registered (esbuild/extension.ts) as an entry-point quick pick over workspace source files
  (ts/tsx/js/jsx/mts/cts; node_modules/.ide-build/.git/dist excluded), last-used entry first,
  which then runs the normal `runBuild` pipeline (including Solid 2.x auto-detection).

## Prototype results (2026-10-29, Solid 2.0 route) - VERIFIED via node scratch tests- `@solidjs/compiler@2.0.0-rc.19` `transform()` works natively (win32-x64) and via `@solidjs/compiler-wasm32-wasi` (@emnapi 1.11.3 + `@napi-rs/wasm-runtime` 1.2.6 - same combo already proven in this repo for rolldown binding).

- Input TSX with signals/For/event handlers -> plain ESM JS, imports only `solid-js` + `@solidjs/web`, sourcemaps ok, ~22 ms per module. Options used: `{ filename, moduleName: '@solidjs/web', generate: 'dom', dev: true }`.
- `@rolldown/browser@1.2.15` bundles in-process with **JS plugins** (resolveId/load/transform all fire; wasm binding + plugin container same worker).
- Full pipeline proven: rolldown wasm bundle of multi-file TSX app, each module compiled by the Solid wasm transform inside a plugin, node_modules resolved via plugin (stand-in for npm/resolver.ts), single 218 KB chunk - no residual JSX/TS outside runtime template strings.
  - Gotchas discovered:
    - `@rolldown/browser@1.2.15` ships a **broken dep combo**: nested `@emnapi/core`+`@emnapi/runtime` 2.0.0-alpha.5 vs hoisted `@napi-rs/wasm-runtime@1.2.6` (which needs emnapi 1.x, and can never see a _nested_ core). Fix (unify.cjs): delete the nested @emnapi/@napi-rs copies under browser/node_modules so everything resolves to emnapi 1.11.3 + wasm-runtime 1.2.6 - then it works. Must re-apply after every `npm i` (npm reifies declared tree). In the IDE this is a vendor/prebuild step (see rolldown/inlineWorkerFactory.ts pattern).
    - Entry files must be claimed by a resolveId hook returning the path (binding resolver does not handle plugin-virtual entries by itself).
    - Naming: without an explicit node-conditions resolver, `solid-js` resolves to its SSR/server build (`solid-js/internal`, `seroval/polyfills`) - the IDE resolver (browser conditions) must be supplied via plugins, which we already have in src/extensions/npm/resolver.ts.
  - Prototype harness: C:\Users\danie\AppData\Local\Temp\opencode\rolldown-alone (test4.mjs = integration; test.mjs = plugin-only; solid2proto/test2.mjs = wasm transform).
- Next: wire `solidPlugin` into esbuild worker's `onLoad` OR swap build path to @rolldown/browser; detection via project deps (`solid-js@^2`) in esbuild.config.json / tsconfig `jsxImportSource: solid-js`.

## Solid 2.0 toolchain wired into the esbuild worker (2026-10-29) - implemented, needs a manual browser test

- `@solidjs/compiler-wasm32-wasi@2.0.0-rc.19` added as a repo dependency; per-module `transform()` runs in the esbuild worker (src/extensions/esbuild/worker.ts `transformSolid` + `ensureSolidBinding`).
- Vite inliner (vite.config.ts `webResourceWasmInline`) now also covers the Solid binding glue: `virtual:solid-wasm-data-url` (embedded .wasm) + `virtual:solid-wasi-inline-worker` (blob wasi thread worker) + regex patch of `compiler.wasi-browser.js` reference patterns (validated: build-output has no raw .wasm fetch / external worker URL left).
- Worker `onLoad` hook: when build request has `solid: 'v2'`, workspace `.jsx`/`.tsx` files are compiled with options `{ filename, moduleName: '@solidjs/web', generate: 'dom', dev: true, sourceMap }`, returning loader `'js'` so esbuild never sees JSX. node_modules files are untouched. Compiler errors surface as esbuild errors for the right file.
- [fix 2026-10-29, #test workspace crash] first Solid build in the esbuild worker died with "worker error: unknown error". Cause: glue's WASI pools (4 async + `max(2, cores)` type-module thread workers spawned _nested_ inside the esbuild worker; the thread worker source imports `@napi-rs/wasm-runtime` as a bare specifier, unresolvable from a blob URL). Since `transform()` is synchronous, pools are unneeded: the vite inliner now rewrites `__asyncWorkPoolSize = 4` -> `0` and `__workerPoolSize` -> `0` so `onCreateWorker` is never invoked (verified folded to 0 in the bundled chunk). `buildRunner.onerror` now logs `event.error` message+stack and `onmessageerror` too, so any remaining failure surfaces with a real cause.
- Plumbing: `BuildRequest.solid` (worker), `BuildRequestInput.solid` (buildRunner), `EsbuildConfig.solid = 'v2' | 'v1' | 'off'` (config.ts; parsed + written by updateEsbuildConfig).
- Auto-detection in esbuild extension.ts `detectSolidVersion`: reads node_modules/solid-js/package.json (and @solidjs/web) version prefix; 2.x -> 'v2'. Explicit config key always wins; 'off' disables; 'v1' recognized but not implemented (needs babel-preset-solid route).
- `npm run build` passes (tsc + vite). Solid glue emitted as async worker chunk `compiler.wasi-browser-*.js` (fetched relatively by the esbuild worker at runtime - works once all dist assets are deployed).
- NOT done yet / follow-ups:
  - manual end-to-end test in dev server + Dataverse deploy (solid-js@2 + @solidjs/web installed, JSX app built)
  - node-runtime engine still transpiles .tsx with plain esbuild (cjs): solid projects should not be run through it until it learns the transform
  - rolldown-browser variant of the pipeline (prototype test4.mjs) kept for later
  - sourcemap chaining (solid compiler map -> esbuild map) currently only passed through when sourcemap enabled, not merged
  - 1.9 support via babel-preset-solid

# Node runtime v2 (direct workspace fs)

- [added 2026-10-31] `src/extensions/node-runtime-v2/`: own async loader + sync
  `require` cache over `vscode.workspace.fs`; almostnode shims for builtins; no
  workspace-wide VFS sync. Sanity harness:
  `tests/nodeRuntimeV2.sanity.mts` (build command in the file header).
- design tradeoff: CJS `require()` is synchronous, so static imports are
  prefetched and dynamic requires / uncached sync fs reads use a
  throw → hydrate → retry loop. Retries re-run module side effects (logged via
  `onRetry`).
- follow-ups:
  - outbound permission gate (currently user code sees the page's `fetch`,
    XHR and WebSocket directly)
  - `.js` config files with custom plugins for esbuild/rolldown (not started)
  - worker realm option for terminability / real CSP-based request isolation
  - `crypto.createHash`, `child_process`, and native `.node` addons are stubs

# Tagged JSX extension

- [added 2026-10-29] src/extensions/taggedJsx/ - port of the "Tagged JSX Tools"
  (DanielRKling.tagged-jsx-vscode) extension features for tagged template literals
  (`html`...`` - the @solidjs/html / @dom-expressions/tagged-jsx runtime syntax):
  - Conversion commands `taggedJsx.toggle` (smart direction by content regex) /
    `taggedJsx.convertToJsx` / `taggedJsx.convertToTagged`, whole-document transform
    via lazily-imported `@tagged-jsx/transform@2.0.0` (shipped as `typescript` +
    `diff`; tsc loads as its own async chunk on first conversion). useCallbacks
    setting wired to `createExpressionTransformCallbacks` (Solid `() =>` lazy bridging),
    registeredComponents / preferredTag / customTags handled by the package. Verified
    round-trips incl. nested JSX in expressions -> nested templates (tests/tagged-transform.sanity.mts,
    run with `node --experimental-strip-types`).
  - TextMate injection grammar (JSX highlighting inside tagged templates): the three
    upstream grammars vendored into src/extensions/taggedJsx/syntaxes/ (jsx.json embedded
    JSX incl. `<${Comp}>` dynamic tags + `<//>` close, lit-jsx-string-injection.json), and
    the primary lit-jsx grammar REGENERATED at runtime from tagged-jsx.customTags with the
    upstream generator algorithm (grammar.ts). JSON served as base64 data URLs via
    registerFileUrl; registered on a single LocalProcess extension via contributes.grammars
    - contributes.languages (jsxt) - extension registry is main-thread shared and
      registerFileUrl only exists on ext-host registrations. "Regenerate Grammar" command
      disposes + re-registers from current tags.
  - Settings under `tagged-jsx.*` (customTags, preferredTag, useCallbacks, registeredComponents)
    contributed identically to upstream defaults.
  - Formatting inside templates was ALREADY covered by the prettier extension
    (@tagged-jsx/prettier-plugin, embeddedJsxTags).
  - NOT ported yet: ts-plugin TypeScript diagnostics inside templates (upstream uses a
    typescriptServerPlugins package; would need a monaco-vscode TS plugin bridge),
    toggleComment command, exemplified keybindings (commands are palette-only for now).
- [added 2026-10-29] esbuild build plugin: `taggedJsx: "off" | "toJsx" | "toTagged"`
  key in esbuild.config.json (default off) + quick pick
  `esbuild: Tagged JSX Transform…` (dataverseIde.esbuild.configureTaggedJsx) that
  writes it. Plumb-through: EsbuildConfig (config.ts parse + write) ->
  BuildRequestInput.taggedJsx (buildRunner.ts) -> BuildRequest.taggedJsx
  (worker.ts) -> the virtual-fs plugin's onLoad.
  - worker.ts: Workspace SOURCE files only (node_modules paths skipped); loaders
    ts/tsx/js/jsx only. The transform runs before the esbuild loaders, memoized
    transformers created on first use (dynamic `import("@tagged-jsx/transform")` +
    `import("typescript")` inside the worker; builds with the plugin off never load
    the ~3.6 MB typescript chunk - vite emits a separate lazy worker-graph chunk:
    typescript-DPm3id58.js).
  - Loader upgrade after a successful conversion: ts -> tsx, js -> jsx (content
    class changes: tagged->JSX direction introduces JSX; the reverse removes it -
    the tsx/jsx loaders accept JSX-free sources so no downgrade needed).
  - Transform failures return the ORIGINAL contents + esbuild onLoad errors
    attributed to that file (build does not abort); toTagged on `.ts`/`.js` files is
    a no-op round trip at worst (no JSX to convert).
  - Same limitations noted for the reverted Solid worker integration: no sourcemap
    chaining (transform is character-mapped, not byte-identical), and in-browser
    end-to-end build with the plugin on still needs a manual test run.

# Rolldown

- [added 2026-10-29] full browser bundling via `@rolldown/browser@1.2.15` (parity with the esbuild
  extension's feature set):
  - `rolldown: Build Current File` / `Build Workspace…` / `Build Configured Entry` +
    Start/Stop/Toggle Watch in src/extensions/rolldown/extension.ts; settings live in
    `rolldown.config.json` (src/extensions/rolldown/config.ts; entryPoints, outdir, format
    esm/iife/cjs/umd, minify, sourcemap (inline), external, define).
  - bundling core: src/extensions/rolldown/bundleCore.ts — virtual-fs JS plugin over the files map
    (entry claim in resolveId per the prototype gotcha), lazy needFiles probe rounds identical to
    the esbuild worker (reuses esbuild/lazyBuild.ts, now structurally typed, logPrefix option);
    unresolved bare/relative imports are externalized non-fatally + reported (esbuild worker
    semantics).
  - SHARED resolver extracted: src/extensions/shared/packageResolver.ts (from esbuild/worker.ts);
    esbuild worker now imports it (no behaviour change; tailwind lazyBuild unchanged).
  - `@rolldown/browser` ships a broken dep combo (nested @emnapi 2.0.0-alpha.5 vs
    @napi-rs/wasm-runtime 1.2.6 needing emnapi 1.x): scripts/unify-rolldown.cjs runs as postinstall
    and deletes the nested copies (mimics the prototype unify.cjs; re-applied on every npm i).
  - vite wasm inliner: the wasi-worker URL regex now matches BOTH glue copies (binding package's
    package-specifier URL and @rolldown/browser's own relative './wasi-worker-browser.mjs').
  - [fixed 2026-10-29 browser] "worker error: unknown error" at boot - the glue's wasi pools
    (asyncWorkPoolSize 4 + workerPoolSize max(2, cores)) spawn module workers from a blob URL whose
    code carries bare '@napi-rs/wasm-runtime' imports (unresolvable from a blob URL); same failure
    mode as the esbuild Solid incident. Fixed by zeroing both pool vars (emnapi runs async work
    inline). Runner now gates requests on a worker 'ready' handshake with 60s boot timeout and logs
    full ErrorEvent detail (message, error, fileName:line).
  - [fixed 2026-10-29 dev] "Failed to fetch dynamically imported module: .../bundleCore.ts" -
    @rolldown/* are INCOMPATIBLE with vite's dep optimizer ("incompatible with the dep optimizer"),
    and when excluded the dev server serves node_modules files through import-analysis only: custom
    plugin transforms never ran on the glue (patch was silently absent in dev). Fix: the copypaste
    patch now lives in scripts/unify-rolldown.cjs (postinstall) and is written IN-PLACE into both
    glue files (idempotent: preamble sentinel). vite.config hook keeps applying (skips
    already-patched sources); optimizeDeps.exclude now lists @rolldown/browser +
    @rolldown/binding-wasm32-wasi. Verified via live dev server: raw serve includes the pool-zero +
    data-URL preamble, virtual modules resolve, and glue's emnapi import hits the top-level unified
    1.x copy (nested @rolldown/browser/node_modules removed again).
  - [fixed 2026-10-29 browser, round 2+3] after the dev-optimizer fix two real boot crashes
    followed, both patched in-place by scripts/unify-rolldown.cjs (v2, idempotent, migrates v1):
    a) bare `process.cwd()` in @rolldown/browser/dist/create-bundler-option-*.js (no process global
    in browser/workers) -> '/'.
    b) pthread spawn failures ("wasi-threads.esm-bundler.js:268" + silent empty error events): blob
    workers were still used by the thread manager; blob-URL module workers cannot resolve bare
    imports. Fixed by NOT using blob workers at all - the glue's `new Worker(new URL(...))`
    points at the original './wasi-worker-browser.mjs' NEXT TO the glue (real URL; dev resolves
    via import-analysis, build bundles via the worker pipeline). Thread pools restored to
    defaults (asyncWorkPoolSize 4 + workerPoolSize) - they work now and bundling uses threads.
    c) STILL "process is not defined" in the spawned pthread workers (ThreadManager logs e.message
    then rethrows a bare Event, which is why main-thread onerror shows nothing). Robust fix: a
    minimal `process` shim installed FIRST in every involved module graph -
    src/extensions/rolldown/processShim.ts (main worker entry) + dataverse-process-shim.mjs
    written next to each glue/worker copy, imported as the first line of both glues and both
    wasi-worker-browser.mjs bootstraps (module evaluation order precedes any bare reference).
    d) vite dev does not WATCH node_modules: after npm i / postinstall patch, RESTART the dev
    server (reload is not enough). And /node_modules/ + /@id/ requests now get no-store in dev
    because the ?v= hash does not change for optimizer-bypassed files - stale browser HTTP cache
    made a round look like a no-op.
    Verified live on the dev server (glue preamble order, shim-first worker bootstraps, /@id/virtual
    data URL, guarded-only process.cwd in served chunks) and vite build passes.
  - verified: `npm run build` passes; bundling sanity harness tests/rolldownBundle.sanity.mts
    (probe round → lazy rounds → full ESM bundle, define substitution, externals; esbuild-bundle the
    test with `npx esbuild tests/rolldownBundle.sanity.mts --bundle --platform=node --format=esm
--external:@rolldown/*` then run the output with node) passes.
  - Follow-ups:
    - rolldown's typing constrains our request format union via esbuild's BuildRequestInput - cast,
      plus dual wasm instantiation (binding + browser glue each compile the wasm; same binary, extra
      memory in the worker when both paths are used).
    - sourcemap is inline-only; esbuild-style separate .map output needs writeOutputs work anyway.
    - npm-resolver browser-conditions: the esbuild resolver limitation applies to rolldown too
      (packages that gate browser builds behind a "browser" condition resolve the same way - good),
      but solid-js@2-style SSR-default packages may need an explicit conditions plugin.
  - verified working in-browser (2026-10-29): full build of a Solid JSX app -
    glue boot, thread workers, 8 lazy-resolution rounds over workspace
    node_modules (solid-js/@solidjs/web/@solidjs/signals manifests), single
    bundle written in ~2.1s. Note for the hot-reload plugin: dev servers must
    include rolldownPatchHotReload (watched glue files + moduleGraph
    invalidateAll) OR a manual restart after any postinstall re-patch - vite dev
    does not otherwise re-read those files.
    first-message debug reporting disabled for happy boot (was 20 lines spam);
    error paths (worker-error/init-failed/messageerror/console forwarding) stay on.

## Solid 2.0 toolchain (second attempt, 2026-10-29, VIA THE ROLLDOWN WORKER)

- Routed through the rolldown bundler worker (its own dedicated worker + proven wasi glue) instead
  of piggybacking on the esbuild worker (first attempt was rolled back for the blob-worker/wasi-pool
  crashes that are now understood and fixed in scripts/unify-rolldown.cjs).
- `@solidjs/compiler-wasm32-wasi@2.0.0-rc.19` installed (hoisted @emnapi 1.11.3 + wasm-runtime
  1.2.6 satisfy it; no nested copies). Its glue patch joins the postinstall: shim prelude, wasm
  data URL -> NEW virtual module `virtual:solid-wasm-data-url` (solid's OWN .wasm - NOT rolldown's),
  relative './wasi-worker-browser.mjs' worker URL, debug hooks; vite optimizeDeps.exclude +
  rolldownPatchHotReload watch list extended; vite fallback patch branch covers 'compiler.wasi-browser.js'.
- bundleCore: request.solid ('v2' | 'off'); a lazy-loaded Dataverse-ide-solid plugin transform
  compiles workspace .jsx/.tsx (node_modules untouched) with { moduleName: '@solidjs/web',
  generate: 'dom', dev: true } BEFORE bundling; compile errors surface as [solid] compile errors for
  the right file. GOTCHA verified: the wasm transform returns errors as UNDEFINED on success - never
  assume result.errors is an array.
- config: rolldown.config.json key "solid": "auto" (default) | "v2" | "off"; 'auto' detects
  solid-js@2.x from node_modules/solid-js/package.json in the collected manifests (same detection
  protocol as the esbuild extension) and logs that it engaged; explicit key wins.
- verified: tests/rolldownSolid.sanity.mts (node) - 'v2' compiles to template()/@solidjs/web with
  externals preserved and NO residual jsx expressions/TS; 'off' keeps oxc loaders (note: uncompiled
  .tsx JSX defaults to react-style jsx-runtime imports - externalize react to finalize in a
  react-less workspace); tsc + vite build pass. Browser e2e (dev server + a solid-js@2 workspace
  through rolldown: Build Current File) still open.
- still open (carry-over from the rolled-back attempt): sourcemap chaining (solid map -> rolldown
  map) - currently not forwarded (map skipped); 1.9 support via babel-preset-solid; node-runtime
  engine does not use this path.

# Rollup

- [added 2026-10-30] `@rollup/browser` bundling extension with the same command surface as
  rolldown (`src/extensions/rollup/`): Build Current File / Build Workspace… / Build Configured
  Entry, Transform TS/JSX→JS, Minify, Start/Stop/Toggle Watch, Open/Reload config.
  Settings live in `rollup.config.json` (entryPoints, outdir, format esm/iife/cjs/umd, minify,
  sourcemap (inline), external, define; path via `dataverseIde.rollup.configPath`).
- [main-thread rewrite] Rollup now runs on the main thread like the esbuild extension. The
  worker, workspace-wide collection, node_modules manifest scan and lazy `needFiles` loop are
  gone. `workspaceResolver.ts` reads through `vscode.workspace.fs` and resolves only files the
  dependency graph actually reaches; a fresh cached reader is created per build.
- `bundleCore.ts`: virtual-fs Rollup plugin over the direct reader. TypeScript/JSX lowering,
  `define` substitution and minification reuse the main-thread `esbuild-wasm` transformer from
  `esbuild/compiler.ts` (`transformForBundler`, initialized once per page):
  - module transform plugin (loader by extension, ESM output, automatic JSX)
  - `renderChunk` minify plugin, so esbuild's map chains through Rollup's sourcemap pipeline
  - JSON modules are turned into ESM (default + identifier-safe named exports)
  - CSS imports are collected and emitted as a single `bundle.css` asset
- Note: the first main-thread attempt used the oxc WASI binding directly. The IDE page already
  has a Node-like `process` polyfill (`process.versions.node`), so `@emnapi/wasi-threads`
  selected its Node path and crashed on `worker.once is not a function`. esbuild-wasm avoids
  that environment-detection path entirely and is already proven on the main thread.
- No SolidJS support in rollup.config.json/bundleCore yet (deliberately deferred; the config key
  and compiler plugin were removed).
- Output writing preserves bundler-provided file names (chunk names, `bundle.css`) instead of
  forcing every output through the entry base name.
- `@rollup/browser` is imported on first build (activation stays light) and is in
  `optimizeDeps.exclude`; every `.wasm` asset is inlined by Vite in production builds, so no
  separate `.wasm` web resource is emitted.
- Sanity harness: `tests/rollupBundle.sanity.mts` (direct reader → ESM bundle, define,
  externals, JSON, CSS extraction, minify + inline sourcemap). The node run aliases
  `esbuild-wasm`/`virtual:esbuild-wasm-binary` to the native esbuild binary and real wasm
  (`tests/esbuildNativeShim.mjs`, `tests/esbuildWasmBinaryMock.mjs`) - see the run command in
  the test header.
- Follow-ups:
  - main-thread Rollup blocks the UI while bundling large graphs; a worker can be reintroduced
    later if needed (the earlier worker implementation lives in git history)
  - `rollup/workspaceResolver.ts` duplicates the esbuild compiler's direct-read package resolver;
    extract a shared async resolver once both settle
  - SolidJS transform support is not wired into this extension yet
  - no CommonJS-to-ESM conversion plugin: Rollup core expects ESM/package `module`/`exports`
    entry points. CJS-only packages can leave `require()` calls in the output (rolldown's
    built-in CJS handling does not apply here)
  - CSS `@import` resolution and minification are not implemented; the asset is a plain
    concatenation of loaded stylesheets
  - `@rollup/browser` has no watch integration of its own; watch remains the shared
    save-driven rebuild engine (like rolldown/esbuild)

# Prettier

- plugins

# TSC

- Wasm version?
- plugins?
