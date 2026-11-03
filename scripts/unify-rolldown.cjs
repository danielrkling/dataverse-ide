/*
 * rolldown + solid postinstall fixes (runs after every npm install).
 *
 * NOTE: this file was accidentally deleted on 2026-11-02 and reconstructed
 * from session notes - it is idempotent by sentinel checks, so re-running
 * over an already-patched tree is safe. If node_modules are fresh, it
 * applies from the pristine package sources.
 *
 * 1. UNIFY: delete broken nested @emnapi 2.0.0-alpha.5 copies under
 *    node_modules/@rolldown/browser/node_modules (the hoisted
 *    @napi-rs/wasm-runtime 1.x needs emnapi 1.x; the runtime glue can
 *    never resolve a *nested* @emnapi/core).
 *    (Verified: rolldown-alone/test4.mjs, 2026-10-29.)
 *
 * 2. PATCH the wasi browser glue files in-place and idempotently so BOTH
 *    vite dev (raw serving; these deps are excluded from the dep optimizer
 *    - they are "incompatible with the dep optimizer") and vite build get
 *    the fixes:
 *      - the wasm binary URL -> inlined data URL import (virtual module;
 *        each glue gets its own: 'virtual:rolldown-wasm-data-url' /
 *        'virtual:solid-wasm-data-url' - the .wasm binaries differ!)
 *      - the wasi thread worker -> relative './wasi-worker-browser.mjs'
 *        URL (shipped next to each glue). NEVER a blob worker: blob-URL
 *        module workers cannot resolve bare imports, which caused silent
 *        boot crashes ("worker error: unknown error") and wasi-threads
 *        pthread failures (same failure mode as the esbuild Solid
 *        incident). A real URL keeps imports resolvable in dev and lets
 *        the vite worker pipeline bundle it for build.
 *      - thread pools intentionally LEFT ENABLED (asyncWorkPoolSize 4 +
 *        workerPoolSize = max(2, cores)); the real-URL workers work now
 *        and the bundler/transform genuinely use threads.
 *      - a minimal `process` shim (dataverse-process-shim.mjs) imported as
 *        the FIRST line of every glue + wasi thread worker bootstrap
 *        (browsers/workers have no process global; module evaluation
 *        order puts the shim before any bare reference).
 *      - debug plumbing (__dataverseRolldownDebug channel): worker error
 *        events + thread bootstrap failures surface in the extension
 *        output channel (first-message reporting disabled post-boot-fix:
 *        it spammed one line per happy worker).
 * 3. PATCH @rolldown/browser option chunks: bare `process.cwd()` (no
 *    process global) -> '/'.
 */
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();

const glueConfigs = [
  {
    file: "node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi-browser.js",
    wasmVirtual: "virtual:rolldown-wasm-data-url",
  },
  {
    file: "node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js",
    wasmVirtual: "virtual:rolldown-wasm-data-url",
  },
  {
    /*
     * Solid 2.0 compiler wasm (JSX transform); its own .wasm differs from
     * rolldown's - a dedicated virtual module is injected.
     */
    file: "node_modules/@solidjs/compiler-wasm32-wasi/compiler.wasi-browser.js",
    wasmVirtual: "virtual:solid-wasm-data-url",
  },
];

const glueFiles = glueConfigs.map((config) => config.file);

const workerFiles = [
  "node_modules/@rolldown/binding-wasm32-wasi/wasi-worker-browser.mjs",
  "node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs",
  "node_modules/@solidjs/compiler-wasm32-wasi/wasi-worker-browser.mjs",
];

const SHIM_FILE_NAME = "dataverse-process-shim.mjs";

const SHIM_CONTENT = [
  "// dataverse-ide: minimal process shim for wasi glue code paths.",
  "// Browsers/workers have no process global; some glue/pthread",
  "  // init paths reference it; guarded checks only read env/cwd.",
  'if (typeof globalThis.process === "undefined") {',
  "  globalThis.process = {",
  "    env: {},",
  "    argv: [],",
  "    version: '',",
  "    versions: {},",
  "    platform: 'browser',",
  "    browser: true,",
  "    title: 'browser',",
  "    cwd: () => '/',",
  "    umask: () => 0,",
  "    nextTick: (callback, ...args) => Promise.resolve().then(() => callback(...args)),",
  "    emit: () => false,",
  "    on: () => 0,",
  "    once: () => 0,",
  "    off: () => 0,",
  "    removeListener: () => 0,",
  "    removeAllListeners: () => 0,",
  "    listeners: () => [],",
  "    binding: (name) => { throw new Error('process.binding is not supported: ' + name) },",
  "    chdir: () => { throw new Error('process.chdir is not supported') },",
  "    exit: (code) => { throw new Error('process.exit(' + code + ') is not supported') },",
  "  }",
  "}",
  "export {}",
  "",
].join("\n");

/*
 * Every runtime that touches the glue imports the shim FIRST: the glue
 * preamble (main/module workers) and the wasi thread worker bootstrap
 * (pthread workers). Module-graph evaluation order guarantees the shim
 * installs before any later bare `process` reference executes.
 */
const gluePreambleFor = (wasmVirtual) =>
  "import './" +
  SHIM_FILE_NAME +
  "'\n" +
  "import __rolldownWasmDataUrl from '" +
  wasmVirtual +
  "'\n\n";

const WORKER_PRELUDE = "import './" + SHIM_FILE_NAME + "'\n";

const WORKER_URL_RE =
  /new Worker\(new URL\('.{0,60}?wasi-worker-browser\.mjs', import\.meta\.url\)/;

const WORKER_URL_REPLACEMENT = "new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url)";

const WASM_URL_RE = /const __wasmUrl = new URL\(.+?\.href/;

const WASM_URL_REPLACEMENT = "const __wasmUrl = __rolldownWasmDataUrl";

/*
 * v1 blob-worker patch migration (superseded approach): remove the
 * blob-worker factory preamble pieces and restore the worker URL + pool
 * expressions before applying the current patch logic.
 */
const V1_PREAMBLE_RE =
  /import __rolldownWasiWorkerCode from 'virtual:rolldown-wasi-inline-worker'\nimport \{ createNapiWasiWorkerBlobUrl as __createNapiWasiWorkerBlobUrl \} from 'virtual:rolldown-wasi-worker-factory'\nconst __rolldownWasiBlobUrl = __createNapiWasiWorkerBlobUrl\(__rolldownWasiWorkerCode\)\n\n/;

function patchGlue() {
  for (const config of glueConfigs) {
    const relative = config.file;
    const file = path.join(repo, relative);

    if (!fs.existsSync(file)) {
      console.warn(`[unify-rolldown] patch: missing file ${relative}`);

      continue;
    }

    let code = fs.readFileSync(file, "utf8");

    // v1 migration: strip stale blob-worker pieces.
    code = code.replace(V1_PREAMBLE_RE, "");
    code = code.replace("new Worker(__rolldownWasiBlobUrl ", WORKER_URL_REPLACEMENT);
    code = code.replace("const __asyncWorkPoolSize = 0", "const __asyncWorkPoolSize = 4");
    code = code.replace(
      "const __workerPoolSize = 0",
      "const __workerPoolSize = Math.max(2, globalThis.navigator?.hardwareConcurrency ?? 4)",
    );

    if (!code.includes(config.wasmVirtual) && !code.includes("import __rolldownWasmDataUrl from")) {
      const patterns = [
        [WASM_URL_RE, WASM_URL_REPLACEMENT],
        [WORKER_URL_RE, WORKER_URL_REPLACEMENT],
      ];

      for (const [pattern, replacement] of patterns) {
        if (!pattern.test(code)) {
          throw new Error(`[unify-rolldown] patch pattern failed on ${relative}:\n  ${pattern}`);
        }

        code = code.replace(pattern, replacement);
      }

      code = gluePreambleFor(config.wasmVirtual) + code;
    } else if (!code.includes(SHIM_FILE_NAME)) {
      /*
       * Sentinel patch exists but lacks the shim import - insert the shim
       * import as the FIRST statement.
       */
      code = code.replace(
        /import __rolldownWasmDataUrl from 'virtual:(rolldown|solid)-wasm-data-url'/,
        gluePreambleFor(config.wasmVirtual).trimEnd(),
      );
    }

    fs.writeFileSync(file, code);

    console.log(`[unify-rolldown] patch: OK ${relative}`);
  }
}

function patchWorkers() {
  for (const relative of workerFiles) {
    const file = path.join(repo, relative);

    if (!fs.existsSync(file)) {
      console.warn(`[unify-rolldown] patch: missing file ${relative}`);

      continue;
    }

    const shimFile = path.join(path.dirname(file), SHIM_FILE_NAME);

    if (!fs.existsSync(shimFile)) {
      fs.writeFileSync(shimFile, SHIM_CONTENT);

      console.log(`[unify-rolldown] shim: wrote ${SHIM_FILE_NAME}`);
    }

    const code = fs.readFileSync(file, "utf8");

    if (!code.includes(SHIM_FILE_NAME)) {
      fs.writeFileSync(file, WORKER_PRELUDE + code);

      console.log(`[unify-rolldown] patch: OK ${relative}`);
    }
  }
}

function patchProcessCwd() {
  const dir = path.join(repo, "node_modules", "@rolldown", "browser", "dist");

  if (!fs.existsSync(dir)) {
    console.warn("[unify-rolldown] patch: @rolldown/browser/dist missing");

    return;
  }

  const needle = "inputOptions.cwd ?? process.cwd()";

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js")) {
      continue;
    }

    const file = path.join(dir, name);

    if (!fs.readFileSync(file, "utf8").includes(needle)) {
      continue;
    }

    const code = fs.readFileSync(file, "utf8");

    fs.writeFileSync(file, code.replace(needle, 'inputOptions.cwd ?? "/"'));

    console.log(`[unify-rolldown] patch: process.cwd() -> '/' in ${name}`);
  }
}

const browserNodeModules = fs.existsSync(
  path.join(repo, "node_modules", "@rolldown", "browser", "node_modules", "@emnapi"),
);

if (browserNodeModules) {
  fs.rmSync(path.join(repo, "node_modules", "@rolldown", "browser", "node_modules", "@emnapi"), {
    recursive: true,
    force: true,
  });

  fs.rmSync(path.join(repo, "node_modules", "@rolldown", "browser", "node_modules", "@napi-rs"), {
    recursive: true,
    force: true,
  });

  console.log("[unify-rolldown] unify: removed nested @emnapi/@napi-rs under @rolldown/browser.");
} else {
  console.log("[unify-rolldown] unify: nothing to remove (no nested @emnapi/@napi-rs).");
}

patchGlue();

patchWorkers();

patchProcessCwd();

/*
 * DIAGNOSTIC PLUMBING (remove once boot is stable).
 *
 * Thread-worker failures are otherwise invisible: the wasi-threads
 * ThreadManager catches a bare error Event (no message/detail) and
 * silently discards unknown message shapes, so nested workers can die
 * without anything reaching the output channel. These patches add a
 * tagged __dataverseRolldownDebug channel:
 *   - glue side: every created worker gets an error listener posting
 *     {kind: 'worker-error', message, filename, lineno, stack}; unknown
 *     messages from child threads are forwarded to the page, where the
 *     runner logs them.
 *   - thread side: globalThis.onmessage is wrapped in try/catch posting
 *     {kind: 'init-failed', error}.
 */
const GLUE_DEBUG_TAIL = `;function __dataverseRolldownAttachWorkerDebug(worker) {
  if (!worker || worker.__dataverseDebugEnabled) {
    return;
  }
  worker.__dataverseDebugEnabled = true;
  worker.addEventListener('error', (event) => {
    try {
      const error = event.error;
      self.postMessage({
        __dataverseRolldownDebug: {
          kind: 'worker-error',
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          errorText: error && error.message,
          stack: error && error.stack !== undefined ? String(error.stack) : undefined,
        },
      });
    } catch (_) {}
  });
  worker.addEventListener('messageerror', () => {
    try {
      self.postMessage({
        __dataverseRolldownDebug: { kind: 'messageerror' },
      });
    } catch (_) {}
  });
};
;(function () {
  const previous = self.onmessage;
  self.onmessage = function (event) {
    try {
      const data = event && event.data;
      if (data && data.__dataverseRolldownDebug) {
        self.postMessage(data);
        return;
      }
    } catch (_) {}
    if (typeof previous === 'function') {
      return previous.call(this, event);
    }
  };
})();
`;

const WORKER_DEBUG_TAIL = `;(function () {
  const previous = globalThis.onmessage;
  if (typeof previous !== 'function') {
    return;
  }
  globalThis.onmessage = function (event) {
    try {
      return previous.call(this, event);
    } catch (error) {
      try {
        postMessage({
          __dataverseRolldownDebug: {
            kind: 'init-failed',
            error: String((error && error.stack) || error),
          },
        });
      } catch (_) {}
      throw error;
    }
  };
})();
`;

function patchDiagnostics() {
  for (const relative of glueFiles) {
    const file = path.join(repo, relative);

    if (!fs.existsSync(file)) {
      continue;
    }

    let code = fs.readFileSync(file, "utf8");

    let changed = false;

    if (!code.includes("__dataverseRolldownAttachWorkerDebug")) {
      code = code.replace(
        "__wasiWorkers.add(worker)",
        "__wasiWorkers.add(worker); __dataverseRolldownAttachWorkerDebug(worker)",
      );

      if (code.includes("__dataverseRolldownAttachWorkerDebug")) {
        code = code + GLUE_DEBUG_TAIL;

        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(file, code);

      console.log(`[unify-rolldown] debug: OK ${relative}`);
    }
  }

  for (const relative of workerFiles) {
    const file = path.join(repo, relative);

    if (!fs.existsSync(file)) {
      continue;
    }

    const code = fs.readFileSync(file, "utf8");

    if (code.includes("__dataverseRolldownDebug")) {
      continue;
    }

    fs.writeFileSync(file, code + "\n" + WORKER_DEBUG_TAIL);

    console.log(`[unify-rolldown] debug: OK ${relative}`);
  }
}

patchDiagnostics();
