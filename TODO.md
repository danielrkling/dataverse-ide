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

# Tagged JSX extension

# Rolldown

- [added 2026-10-29] full browser bundling via `@rolldown/browser@1.2.15` (parity with the esbuild
  extension's feature set):
  - `rolldown: Build Current File` / `Build Workspace…` / `Build Configured Entry` +
    Start/Stop/Toggle Watch in src/extensions/rolldown/extension.ts; settings live in
    `rolldown.config.json` (src/extensions/rolldown/config.ts; entry, outDir, format
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

# Prettier

- plugins

# TSC

- Wasm version?
- plugins?
