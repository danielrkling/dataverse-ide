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
       * node_modules files served raw (optimizeDeps-excluded deps like the
       * rolldown glue) would otherwise be cached with immutable semantics
       * keyed by the ?v= hash, which does NOT change when the dep-optimizer
       * is bypassed - postinstall patches to those files would never reach
       * the browser. No-store (dev only).
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
 * Dev-only: vite's file watcher ignores node_modules entirely, so an
 * in-place postinstall patch of the rolldown glue files (scripts/
 * unify-rolldown.cjs) would keep being served from the stale transform
 * cache for the lifetime of the dev server. Watch the patched files
 * explicitly and invalidate the module graph when they change.
 */
const rolldownPatchHotReload: Plugin = {
  name: "dataverse-ide-rolldown-patch-hot-reload",
  apply: "serve",
  configureServer(server) {
    const watchedFiles = [
      "node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi-browser.js",
      "node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js",
      "node_modules/@solidjs/compiler-wasm32-wasi/compiler.wasi-browser.js",
      "node_modules/@rolldown/binding-wasm32-wasi/wasi-worker-browser.mjs",
      "node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs",
      "node_modules/@solidjs/compiler-wasm32-wasi/wasi-worker-browser.mjs",
      "node_modules/@rolldown/binding-wasm32-wasi/dataverse-process-shim.mjs",
      "node_modules/@rolldown/browser/dist/dataverse-process-shim.mjs",
      "node_modules/@solidjs/compiler-wasm32-wasi/dataverse-process-shim.mjs",
      "node_modules/@rolldown/browser/dist/create-bundler-option-BxvvnNQf.js",
    ];

    server.watcher.add(watchedFiles);

    server.watcher.on("change", (file) => {
      if (!watchedFiles.some((watched) => file.includes(watched))) {
        return;
      }

      server.moduleGraph.invalidateAll();
    });
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
 * Dataverse web resources cannot host .wasm files, so the esbuild and
 * rolldown workers obtain their compiler binaries through virtual modules
 * that embed the binaries at build time (kept out of the global
 * assetsInlineLimit - raising that would also inline tsserver's large JS
 * assets). All three virtual modules are created here:
 *
 *   virtual:esbuild-wasm-binary        esbuild.wasm as a base64 string
 *   virtual:rolldown-wasm-data-url     rolldown wasm as a data URL (fetched)
 *   virtual:rolldown-wasi-inline-worker  wasi thread worker as an inline
 *                                        blob-worker factory string
 *
 * rolldown ships a browser glue (rolldown-binding.wasi-browser.js, napi-rs
 * wasi) whose wasm/worker references are plain `new URL(..., import.meta.url)`
 * patterns. The transform hook below rewrites those references onto the
 * virtual modules; if the glue's source patterns change upstream, the hook
 * errors instead of silently emitting separate asset files.
 */
const webResourceWasmInline: Plugin = {
  name: "dataverse-ide-wasm-inline",
  resolveId(id: string) {
    if (
      id === "virtual:esbuild-wasm-binary" ||
      id === "virtual:rolldown-wasm-data-url" ||
      id === "virtual:solid-wasm-data-url" ||
      id === "virtual:rolldown-wasi-inline-worker" ||
      id === "virtual:brotli-wasm-data-url" ||
      id === "virtual:rolldown-wasi-worker-factory"
    ) {
      if (id === "virtual:rolldown-wasi-worker-factory") {
        return path.resolve(import.meta.dirname, "src/extensions/rolldown/inlineWorkerFactory.ts");
      }

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

    if (id === "virtual:rolldown-wasm-data-url") {
      const wasmPath = path.join(
        import.meta.dirname,
        "node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm",
      );

      const base64 = fs.readFileSync(wasmPath).toString("base64");

      return `export default ${JSON.stringify(`data:application/wasm;base64,${base64}`)}`;
    }

    if (id === "virtual:solid-wasm-data-url") {
      const wasmPath = path.join(
        import.meta.dirname,
        "node_modules/@solidjs/compiler-wasm32-wasi/compiler.wasm32-wasi.wasm",
      );

      const base64 = fs.readFileSync(wasmPath).toString("base64");

      return `export default ${JSON.stringify(`data:application/wasm;base64,${base64}`)}`;
    }

    if (id === "virtual:brotli-wasm-data-url") {
      const wasmPath = path.join(
        import.meta.dirname,
        "node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm",
      );

      const base64 = fs.readFileSync(wasmPath).toString("base64");

      return `export default ${JSON.stringify(`data:application/wasm;base64,${base64}`)}`;
    }

    if (id === "virtual:rolldown-wasi-inline-worker") {
      const workerPath = path.resolve(
        import.meta.dirname,
        "node_modules/@rolldown/binding-wasm32-wasi/wasi-worker-browser.mjs",
      );

      const workerCode = fs.readFileSync(workerPath).toString("utf8");

      return `export default ${JSON.stringify(workerCode)}`;
    }

    return null;
  },
  transform(code: string, id: string) {
    const normalizedId = id.replaceAll("\\", "/");

    if (
      normalizedId.endsWith("rolldown-binding.wasi-browser.js") ||
      normalizedId.endsWith("compiler.wasi-browser.js")
    ) {
      const isSolidGlue = normalizedId.endsWith("compiler.wasi-browser.js");

      const wasmVirtual = isSolidGlue
        ? "virtual:solid-wasm-data-url"
        : "virtual:rolldown-wasm-data-url";

      /*
       * Sources are normally ALREADY patched in-place by
       * scripts/unify-rolldown.cjs (postinstall); skip those. For
       * unpatched stragglers we apply only the safe rewrites: wasm data
       * URL + a REAL wasi-worker URL (never blob workers - blob-URL
       * module workers cannot resolve bare imports, which broke boots and
       * pthread spawns) and leave the thread pools at their defaults.
       */
      if (code.includes("__rolldownWasmDataUrl") || code.includes("__dataverseRolldownDebug")) {
        return null;
      }

      const patched = code
        .replace(/const __wasmUrl = new URL\(.+?\.href/, "const __wasmUrl = __rolldownWasmDataUrl")
        .replace(
          /new Worker\(new URL\('.{0,60}?wasi-worker-browser\.mjs', import\.meta\.url\)/,
          "new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url)",
        );

      const preamble = `import __rolldownWasmDataUrl from '${wasmVirtual}'\n\n`;

      return {
        code: preamble + patched,
        map: null,
      };
    }

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
  // In Dataverse, assets are published as web resources under a path prefix,
  // e.g. DV_BASE=/webresources/dv_/ide
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
    // inline all binary assets (onig.wasm 466KB, diff_wasm_bg.wasm 118KB,
    // codicon.ttf 153KB) as base64 data URLs into the JS chunks instead.
    // (esbuild.wasm + the rolldown wasm + its wasi worker are force-inlined
    // separately through the virtual modules in webResourceWasmInline;
    // raising this limit globally would also inline tsserver's large JS
    // assets and produce a >100MB chunk.)
    assetsInlineLimit: 1000000,
  },
  worker: {
    format: "es",
    // Worker code is re-bundled with its own plugin list - share the wasm
    // inliner so the workers can load the virtual wasm modules
    plugins: () => [webResourceWasmInline],
  },
  plugins: [
    configureResponseHeaders,
    rolldownPatchHotReload,
    forcePreventTransformAssets,
    webResourceWasmInline,
  ],
  optimizeDeps: {
    // brotli-wasm's wasm URL reference breaks the dev pre-bundler's
    // import.meta.resolve; excluded so vite serves/patches it directly
    exclude: [
      "@vscode/diff",
      "brotli-wasm",
      // esbuild's optimizer cannot bundle the rolldown/solid wasm glues
      // (wasi cjs entries, dynamic worker URLs): serve them through the
      // transform pipeline instead, which also applies the wasm/worker
      // inliner (webResourceWasmInline)
      "@rolldown/browser",
      "@rolldown/binding-wasm32-wasi",
      "@solidjs/compiler-wasm32-wasi",
    ],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
  },
});
