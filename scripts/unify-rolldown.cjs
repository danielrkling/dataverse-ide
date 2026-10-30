/*
 * rolldown postinstall fixes (runs after every npm install):
 *
 * 1. UNIFY: delete the broken nested @emnapi 2.0.0-alpha.5 copies under
 *    node_modules/@rolldown/browser/node_modules (the hoisted
 *    @napi-rs/wasm-runtime 1.x needs emnapi 1.x; the runtime glue can
 *    never resolve a *nested* @emnapi/core).
 *    (Verified: rolldown-alone/test4.mjs, 2026-10-29.)
 *
 * 2. PATCH the browser glue files (rolldown-binding.wasi-browser.js),
 *    in-place and idempotent, so BOTH vite dev (raw serving; excluded from
 *    the dep optimizer - @rolldown/* is "incompatible with the dep
 *    optimizer") and vite build get the fixes:
 *      - the wasm binary URL -> inlined data URL (virtual module
 *        'virtual:rolldown-wasm-data-url'; web resources cannot host
 *        separate .wasm files)
 *      - the wasi thread worker -> relative './wasi-worker-browser.mjs'
 *        URL. NEVER a blob worker: blob-URL module workers cannot resolve
 *        bare imports ('@napi-rs/wasm-runtime') - their spawn failures
 *        surface as silent "worker error: unknown error" boot crashes and
 *        wasi-threads pthread errors (same failure mode as the esbuild
 *        Solid incident). A real URL keeps imports resolvable in dev and
 *        lets the vite worker pipeline bundle it for build.
 *      - thread pools intentionally LEFT ENABLED (they need the real-URL
 *        worker above to function).
 * 3. PATCH @rolldown/browser option chunks: bare `process.cwd()` (no
 *    `process` global in browser/worker) -> '/'.
 */
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();

const glueFiles = [
  "node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi-browser.js",
  "node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js",
];

const workerFiles = [
  "node_modules/@rolldown/binding-wasm32-wasi/wasi-worker-browser.mjs",
  "node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs",
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

const SENTINEL = "virtual:rolldown-wasm-data-url";

/*
 * Every runtime that touches the glue imports the shim FIRST: the glue
 * preamble (main/module workers) and the wasi thread worker bootstrap
 * (pthread workers). Module-graph evaluation order guarantees the shim
 * installs before any later bare `process` reference executes.
 */
const GLUE_PREAMBLE =
  "import './" +
  SHIM_FILE_NAME +
  "'\n" +
  "import __rolldownWasmDataUrl from 'virtual:rolldown-wasm-data-url'\n\n";

const WORKER_PRELUDE = "import './" + SHIM_FILE_NAME + "'\n";

/*
 * Both glue copies reference the wasi worker this way (broadened pattern
 * matching the binding package's package-specifier URL and the browser
 * copy's own relative URL alike). The replacement targets the original
 * worker file NEXT TO the glue file - both packages ship it.
 */
const WORKER_URL_RE =
  /new Worker\(new URL\('.{0,60}?wasi-worker-browser\.mjs', import\.meta\.url\)/;

const WORKER_URL_REPLACEMENT = "new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url)";

const WASM_URL_RE = /const __wasmUrl = new URL\(.+?\.href/;

const WASM_URL_REPLACEMENT = "const __wasmUrl = __rolldownWasmDataUrl";

/*
 * v1 blob-worker patch migration (2026-10-29 morning attempt): remove the
 * blob-worker factory preamble pieces and restore the worker URL + pool
 * expressions before applying the current patch logic.
 */
const V1_PREAMBLE_RE =
  /import __rolldownWasiWorkerCode from 'virtual:rolldown-wasi-inline-worker'\nimport \{ createNapiWasiWorkerBlobUrl as __createNapiWasiWorkerBlobUrl \} from 'virtual:rolldown-wasi-worker-factory'\nconst __rolldownWasiBlobUrl = __createNapiWasiWorkerBlobUrl\(__rolldownWasiWorkerCode\)\n\n/;

function patchGlue(files) {
  for (const relative of files) {
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

    if (!code.includes(SENTINEL)) {
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

      code = GLUE_PREAMBLE + code;
    } else if (!code.includes(SHIM_FILE_NAME)) {
      /*
       * Sentinel patch exists but lacks the shim import (v1/v2 glue) -
       * insert the shim import as the FIRST statement.
       */
      code = code.replace(
        "import __rolldownWasmDataUrl from 'virtual:rolldown-wasm-data-url'",
        GLUE_PREAMBLE.trimEnd(),
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

patchGlue(glueFiles);

patchWorkers();

patchProcessCwd();

/*
 * DIAGNOSTIC PLUMBING (remove once boot is stable).
 *
 * Thread-worker failures are otherwise invisible: the wasi-threads
 * ThreadManager catches a bare error Event (no message/detail) at esm
 * line ~268 and silently discards unknown message shapes, so nested
 * workers can die without anything reaching the output channel. These
 * patches add a tagged __dataverseRolldownDebug channel:
 *   - glue side: every created worker gets an error listener posting
 *     {kind: 'worker-error', message, filename, lineno, stack}; unknown
 *     messages arriving in the glue (from child threads) are forwarded to
 *     the page, where the runner logs them.
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

      code = code + GLUE_DEBUG_TAIL;

      changed = true;
    } else if (!code.includes("worker-first-message")) {
      /*
       * Debug plumbing v2: also report the first message a spawned
       * worker receives (proves which stage completed before failure).
       * DISABLED now that boot works end-to-end: for a happy boot this
       * spams one line per spawned worker (pools + pthreads). The error
       * paths (worker-error / init-failed / messageerror) stay on.
       */
      console.log(
        "[unify-rolldown] debug v2: first-message reporting disabled for happy boot (skipped)",
      );

      continue;
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
