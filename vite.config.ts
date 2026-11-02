import { defineConfig, type Plugin } from "vite";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import * as fs from "fs";
import path from "path";

// For the *-language-features extensions (tsserver) which use SharedArrayBuffer
const configureResponseHeaders: Plugin = {
  name: "configure-response-headers",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

      /*
       * node_modules files served raw (optimizeDeps-excluded deps) would
       * otherwise be cached with immutable semantics keyed by the ?v= hash,
       * which does NOT change when the dep optimizer is bypassed. No-store
       * (dev only) keeps edited or locally patched dependency files fresh.
       */
      const pathname = (req.originalUrl ?? "").split("?")[0];

      if (pathname.startsWith("/node_modules/") || pathname.startsWith("/@id/")) {
        res.setHeader("Cache-Control", "no-store");
      }

      next();
    });
  },
};

// Serve .html files raw, without vite transformation (e.g. the web worker
// extension host iframe which must run untouched in its sandboxed iframe)
/*
 * monaco-vscode-api's background tokenizer does:
 *
 *   const { applyStateStackDiff, INITIAL } =
 *     await import('@codingame/monaco-vscode-api/_virtual/main').then(n => n.main)
 *
 * In a production build rollup tree-shakes the dynamic-import target down to
 * the exports it sees being used (`main`), while Vite rewrites the consumer's
 * `.then(n => n.main)` indirection into a top-level destructure. The two
 * disagree and `applyStateStackDiff` ends up undefined at runtime:
 *
 *   Cannot destructure property 'applyStateStackDiff' of '(intermediate value)'
 *
 * Redirect `_virtual/main` to a shim that exposes the vscode-textmate API both
 * at the top level and under `main`, and make the destructuring consumers use
 * the namespace directly. Both shapes then resolve no matter how rollup
 * rewrites the import.
 */
let isProductionBuild = false;

const textmateMainShim: Plugin = {
  name: "dataverse-ide-textmate-main-shim",
  enforce: "pre",
  configResolved(config) {
    isProductionBuild = config.command === "build";
  },
  resolveId(id: string) {
    if (id === "@codingame/monaco-vscode-api/_virtual/main") {
      return "\0dataverse-ide-textmate-main";
    }

    if (id === "\0dataverse-ide-textmate-main") {
      return id;
    }

    return null;
  },
  load(id: string) {
    if (id !== "\0dataverse-ide-textmate-main") {
      return null;
    }

    const vscodeTextmateMain = path.join(
      import.meta.dirname,
      "node_modules/@codingame/monaco-vscode-api/_virtual/main.js",
    );

    /*
     * The absolute path is important: it bypasses resolveId above, so the shim
     * does not alias itself recursively. Importing the namespace statically
     * also stops rollup from tree-shaking the real `main`/`default` exports.
     */
    return [
      `import * as __vscodeTextmateModule from ${JSON.stringify(vscodeTextmateMain)};`,
      "const __vscodeTextmate = __vscodeTextmateModule.main ?? __vscodeTextmateModule.default;",
      "export const applyStateStackDiff = __vscodeTextmate.applyStateStackDiff;",
      "export const diffStateStacksRefEq = __vscodeTextmate.diffStateStacksRefEq;",
      "export const INITIAL = __vscodeTextmate.INITIAL;",
      "export const main = __vscodeTextmate;",
      "export default __vscodeTextmate;",
      "",
    ].join("\n");
  },
  transform(code: string, id: string) {
    const normalizedId = id.replaceAll("\\", "/");

    /*
     * Only the consumers that destructure the dynamic import result need the
     * identity rewrite. Callers that assign the whole module (`vscodeTextmate`)
     * keep using `.main`, which the shim provides.
     */
    if (
      normalizedId.includes("textMateWorkerTokenizerController") ||
      normalizedId.includes("backgroundTokenization/worker/textMateWorkerTokenizer.js")
    ) {
      let patched = code.replace(
        /\.then\(function \(n\) \{ return n\.main; \}\)/g,
        ".then(function (n) { return n; })",
      );

      /*
       * The background tokenizer normally sends state *deltas* relative to the
       * state of the previous line, and the main thread applies them to its own
       * copy of that state. If the main thread ever misses/skips a line state,
       * the pops in the next delta underflow and throw:
       *
       *   Cannot read properties of null (reading 'parent')
       *
       * Making the worker serialize each state relative to `null` (a full
       * state-stack reconstruction) and applying it from `null` on the main
       * thread removes the inter-line dependency entirely. This is a little
       * more data per line but makes the protocol self-contained and immune to
       * skipped batches / reordered states.
       */
      /*
       * Build-only: in dev the textmate service override is prebundled by the
       * dep optimizer, so the matching controller transform below cannot be
       * applied to it. Keeping the worker on the original relative-delta
       * protocol in dev keeps both ends consistent.
       */
      if (isProductionBuild) {
        if (normalizedId.includes("backgroundTokenization/worker/textMateWorkerTokenizer.js")) {
          patched = patched
            .replace(
              /this\._diffStateStacksRefEqFn\(lineToTokenize\.startState, r\.endState\)/g,
              "this._diffStateStacksRefEqFn(null, r.endState)",
            )
            .replace(
              /stateDeltaBuilder\.setState\(lineToTokenize\.lineNumber, null\);/g,
              "stateDeltaBuilder.setState(lineToTokenize.lineNumber, this._diffStateStacksRefEqFn(null, r.endState));",
            );
        }

        if (normalizedId.includes("textMateWorkerTokenizerController")) {
          patched = patched.replace(
            /state = this\._applyStateStackDiffFn\(prevState, delta\);/g,
            "state = this._applyStateStackDiffFn(null, delta);",
          );
        }
      }

      if (patched !== code) {
        return { code: patched, map: null };
      }
    }

    return null;
  },
};

const forcePreventTransformAssets: Plugin = {
  name: "force-prevent-transform-assets",
  apply: "serve",
  configureServer(server) {
    return () => {
      server.middlewares.use(async (req, res, next) => {
        if (req.originalUrl == null) {
          next();
          return;
        }
        const pathname = new URL(req.originalUrl, import.meta.url).pathname;
        if (!pathname.startsWith("/") || !pathname.endsWith(".html")) {
          next();
          return;
        }
        const filePath = path.join(import.meta.dirname, pathname);
        if (!fs.existsSync(filePath)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/html");
        res.writeHead(200);
        res.end(fs.readFileSync(filePath));
      });
    };
  },
};

/*
 * Webresource wasm embedding.
 *
 * Dataverse web resources cannot host .wasm files, so the esbuild worker and
 * brotli obtain their binaries through virtual modules that embed them at
 * build time (kept out of the global assetsInlineLimit - raising that would
 * also inline tsserver's large JS assets). The virtual modules are:
 *
 *   virtual:esbuild-wasm-binary        esbuild.wasm as a base64 string
 *   virtual:brotli-wasm-data-url       brotli wasm as a data URL
 *
 * brotli-wasm references its binary through `new URL(..., import.meta.url)`.
 * The transform hook below rewrites that reference onto the virtual module;
 * if the upstream pattern changes, the hook errors instead of silently
 * emitting a separate asset file.
 */
const webResourceWasmInline: Plugin = {
  name: "dataverse-ide-wasm-inline",
  resolveId(id: string) {
    if (id === "virtual:esbuild-wasm-binary" || id === "virtual:brotli-wasm-data-url") {
      return id;
    }

    return null;
  },
  load(id: string) {
    if (id === "virtual:esbuild-wasm-binary") {
      const wasmPath = path.join(import.meta.dirname, "node_modules/esbuild-wasm/esbuild.wasm");

      const base64 = fs.readFileSync(wasmPath).toString("base64");

      return `export default ${JSON.stringify(base64)}`;
    }

    if (id === "virtual:brotli-wasm-data-url") {
      const wasmPath = path.join(
        import.meta.dirname,
        "node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm",
      );

      const base64 = fs.readFileSync(wasmPath).toString("base64");

      return `export default ${JSON.stringify(`data:application/wasm;base64,${base64}`)}`;
    }

    return null;
  },
  transform(code: string, id: string) {
    const normalizedId = id.replaceAll("\\", "/");

    if (normalizedId.endsWith("pkg.web/brotli_wasm.js")) {
      const patched = code.replace(
        /input = new URL\('brotli_wasm_bg\.wasm', import\.meta\.url\);/,
        "input = __brotliWasmDataUrl;",
      );

      if (patched === code) {
        this.error(
          "brotli-wasm pkg.web reference patterns changed; update the vite-config wasm inliner.",
        );
      }

      const preamble = "import __brotliWasmDataUrl from 'virtual:brotli-wasm-data-url'\n";

      return {
        code: preamble + patched,
        map: null,
      };
    }

    return null;
  },
};

export default defineConfig({
  // Assets are referenced relative to the page (base "./"), so the bundle works
  // under any Dataverse web-resource folder, e.g. /WebResources/dv_ide/
  base: "./",
  resolve: {
    alias: [
      {
        find: /^node:zlib$/,
        replacement: path.resolve(import.meta.dirname, "src/stubs/zlibShim.ts"),
      },
      {
        find: /^\/assets\/runtime-worker-[A-Za-z0-9_-]+\.js$/,
        replacement: path.resolve(import.meta.dirname, "src/stubs/almostnodeRuntimeWorker.ts"),
      },
      {
        /*
         * The Solid Babel compiler path (@babel/core) imports Node's `path`.
         * Vite externalizes builtins to an empty stub in the browser, which
         * breaks Babel's config/cwd handling at runtime. path-browserify is
         * the standard drop-in for the APIs Babel uses (resolve, sep,
         * relative, dirname, ...).
         */
        find: /^path$/,
        replacement: "path-browserify",
      },
      {
        // Optional xterm addon (dynamically imported by the terminal service
        // override) - its node builtin imports break the browser bundle, and
        // font-ligature shaping is irrelevant here
        find: /^@xterm\/addon-ligatures$/,
        replacement: path.resolve(import.meta.dirname, "src/stubs/xtermLigatures.ts"),
      },
    ],
  },
  build: {
    // monaco-vscode-api relies on dynamic imports of wasm / large chunks
    chunkSizeWarningLimit: 5000,
    target: "es2022",
    sourcemap: false,
    // NOTE: don't add manualChunks or hash-free file names here - both
    // explode the module graph:
    //  - topical manualChunks cut through genuine dependency cycles in the
    //    monaco/VSCode sources ("Cannot access 'v' before initialization")
    //  - hash-free names break the bundled webWorkerExtensionHostIframe.html
    //    (relative module specifiers stop resolving)
    // The web resources don't support the `.wasm` type:
    // inline every wasm asset regardless of size (onig.wasm 466KB,
    // diff_wasm_bg.wasm 118KB), and other binary assets under 1MB
    // (codicon.ttf 153KB) as base64 data URLs into the JS chunks instead.
    // Returning false for larger non-wasm assets keeps tsserver's multi-MB
    // JS out of the main chunk (a global numeric raise would inline it and
    // produce a >100MB chunk). esbuild.wasm is force-inlined separately
    // through the virtual module in webResourceWasmInline.
    assetsInlineLimit: (filePath, content) =>
      filePath.endsWith(".wasm") || content.length < 1000000,
  },
  worker: {
    format: "es",
    // Worker code is re-bundled with its own plugin list - share the textmate
    // main shim and the wasm inliner so workers resolve both virtual modules
    plugins: () => [textmateMainShim, webResourceWasmInline],
  },
  plugins: [
    textmateMainShim,
    configureResponseHeaders,
    forcePreventTransformAssets,
    webResourceWasmInline,
  ],
  optimizeDeps: {
    /*
     * Solid's Babel compilers are lazily imported by the esbuild extension.
     * Vite only discovers dynamic imports at runtime, so pre-bundle them to
     * avoid a dep-optimizer reload in the middle of the first Solid build.
     */
    include: [
      "@babel/core",
      "@babel/preset-typescript",
      "@solidjs/babel-plugin",
      "babel-preset-solid",
    ],
    // brotli-wasm's wasm URL reference breaks the dev pre-bundler's
    // import.meta.resolve; excluded so vite serves/patches it directly
    exclude: ["@vscode/diff", "brotli-wasm"],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
  },
});
