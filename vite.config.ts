import { defineConfig, type Plugin } from "vite";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import * as fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/*
 * VS Code's webview host registers its service worker from
 *
 *   <serviceWorkerUri>?v=<version>&vscode-resource-base-authority=...&...
 *
 * Dataverse answers that query-stringed web-resource URL with a redirect, and
 * service-worker script fetches use redirect: "error", so registration fails:
 *
 *   Could not register service worker: SecurityError: Failed to register a
 *   ServiceWorker for scope ... The script resource is behind a redirect,
 *   which is disallowed.
 *
 * Serve the webview pre assets from a stable, query-free /webview/ folder
 * instead. The worker keeps its own ("/webview/") scope, so it does not
 * replace the app-wide PWA service worker, and it still covers both the shell
 * and the fake content page so webview resource URLs resolve.
 *
 * The worker read its configuration (resource base authority, remote
 * authority, platform) from the query string. Since the query string is what
 * triggers the Dataverse redirect, bake the browser defaults into the served
 * copy instead. The shell's inline script is covered by a CSP hash, so the
 * hash is recomputed whenever the registration line is patched.
 */
const WEBVIEW_PRE_DIR = path.join(
  import.meta.dirname,
  "node_modules/@codingame/monaco-vscode-view-common-service-override/service-override/viewCommon/vs/workbench/contrib/webview/browser/pre",
);

function readWebviewPre(name: string): string {
  return fs.readFileSync(path.join(WEBVIEW_PRE_DIR, name), "utf8");
}

function patchWebviewServiceWorker(source: string): string {
  const navigationMarker = "sw.addEventListener('fetch', (event) => {";
  const remoteAuthorityMarker = "const remoteAuthority = searchParams.get('remoteAuthority');";
  const resourceBaseAuthorityMarker =
    "const resourceBaseAuthority = searchParams.get('vscode-resource-base-authority');";

  if (
    !source.includes(navigationMarker) ||
    !source.includes(remoteAuthorityMarker) ||
    !source.includes(resourceBaseAuthorityMarker)
  ) {
    throw new Error(
      "monaco-vscode-api webview service worker changed; update the patch in vite.config.ts.",
    );
  }

  /*
   * The workbench document is cross-origin isolated (COEP), so iframes it
   * embeds must also carry a COEP header - Chromium fails them with
   * "coep-frame-resource-needs-coep-header" otherwise. The app-wide PWA
   * worker used to add these headers to every navigation, but this worker
   * now owns the /webview/ scope, so it has to add them itself.
   */
  const withNavigationHeaders = `${navigationMarker}
	const navigationUrl = new URL(event.request.url);

	if (event.request.mode === 'navigate' && navigationUrl.origin === sw.location.origin) {
		event.respondWith(fetch(event.request).then((response) => {
			const headers = new Headers(response.headers);

			headers.set('Cross-Origin-Opener-Policy', 'same-origin');
			headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
			headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}));

		return;
	}
`;

  const patched = source
    .replace(navigationMarker, withNavigationHeaders)
    .replace(
      remoteAuthorityMarker,
      "const remoteAuthority = searchParams.get('remoteAuthority') ?? '';",
    )
    .replace(
      resourceBaseAuthorityMarker,
      "const resourceBaseAuthority = searchParams.get('vscode-resource-base-authority') ?? 'vscode-resource.vscode-cdn.net';",
    );

  return patched;
}

function patchWebviewShell(source: string): string {
  const patched = source.replace(
    /\t\t\tconst swPath = encodeURI\([^\n]*\);/,
    "\t\t\tconst swPath = serviceWorkerUri;",
  );

  if (patched === source) {
    throw new Error(
      "monaco-vscode-api webview index.html changed; update the service-worker registration patch in vite.config.ts.",
    );
  }

  const inlineScript = patched.match(/<script async type="module">([\s\S]*?)<\/script>/);

  if (inlineScript == null) {
    throw new Error(
      "monaco-vscode-api webview index.html no longer has the expected inline module script.",
    );
  }

  /*
   * The meta CSP pins the inline script by hash. The registration edit above
   * changes the script, so recompute it or the shell silently stops running.
   */
  const hash = createHash("sha256").update(inlineScript[1]).digest("base64");

  return patched.replace(/'sha256-[^']+'/, `'sha256-${hash}'`);
}

function buildWebviewPreAssets(): Record<string, string> {
  return {
    "index.html": patchWebviewShell(readWebviewPre("index.html")),
    "fake.html": readWebviewPre("fake.html"),
    "service-worker.js": patchWebviewServiceWorker(readWebviewPre("service-worker.js")),
  };
}

const webviewPreAssetsServe: Plugin = {
  name: "dataverse-ide-webview-pre",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.originalUrl ?? "/", "http://localhost").pathname;
      const prefix = "/webview/";

      if (!pathname.startsWith(prefix)) {
        next();
        return;
      }

      const name = pathname.slice(prefix.length);
      const assets = buildWebviewPreAssets();

      if (assets[name] == null) {
        next();
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      /*
       * This middleware ends the response before the shared
       * configureResponseHeaders middleware runs, so apply the same isolation
       * headers here. The workbench parent is cross-origin isolated and
       * Chromium blocks an embedding response that does not opt in.
       */
      res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader(
        "Content-Type",
        name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
      );
      res.end(assets[name]);
    });
  },
};

const webviewPreAssetsBuild: Plugin = {
  name: "dataverse-ide-webview-pre-build",
  apply: "build",
  buildStart() {
    // fileName (not name) keeps these URLs stable and free of a content hash.
    for (const [name, source] of Object.entries(buildWebviewPreAssets())) {
      this.emitFile({ type: "asset", fileName: `webview/${name}`, source });
    }
  },
};

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
 *   virtual:esbuild-wasm-gzip-url       esbuild.wasm, gzip-compressed and
 *                                       base64-encoded into its own .txt web
 *                                       resource (~4.2MB), fetched and
 *                                       decompressed at runtime
 *   virtual:brotli-wasm-data-url       brotli wasm as a data URL
 *
 * esbuild.wasm is 11.8MB raw, which used to be inlined into the compiler chunk
 * as 15.7MB of base64 and exceeded Dataverse's 5MB per-web-resource limit.
 * Gzip+base64 keeps it in one asset under that limit.
 *
 * brotli-wasm references its binary through `new URL(..., import.meta.url)`.
 * The transform hook below rewrites that reference onto the virtual module;
 * if the upstream pattern changes, the hook errors instead of silently
 * emitting a separate asset file.
 */
const webResourceWasmInline: Plugin = {
  name: "dataverse-ide-wasm-inline",
  resolveId(id: string) {
    if (id === "virtual:esbuild-wasm-gzip-url" || id === "virtual:brotli-wasm-data-url") {
      return id;
    }

    return null;
  },
  load(id: string) {
    if (id === "virtual:esbuild-wasm-gzip-url") {
      const wasmPath = path.join(import.meta.dirname, "node_modules/esbuild-wasm/esbuild.wasm");

      /*
       * A directly emitted asset is not subject to assetsInlineLimit, so this
       * stays a separate web resource instead of being folded into the chunk.
       */
      const referenceId = this.emitFile({
        type: "asset",
        name: "esbuild.wasm.gz.b64.txt",
        source: gzipSync(fs.readFileSync(wasmPath), { level: 9 }).toString("base64"),
      });

      return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
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

/*
 * Source maps are devtools-only and not a Dataverse web-resource type.
 * Vendor extensions reference their `.map` files via `new URL(...)`, which
 * makes Vite emit them as assets (~59MB). Drop them from the build output;
 * browsers only request them when devtools is open, so the missing file is
 * harmless.
 */
const dropSourceMapAssets: Plugin = {
  name: "dataverse-ide-drop-source-maps",
  apply: "build",
  generateBundle(_options, bundle) {
    for (const name of Object.keys(bundle)) {
      if (name.endsWith(".map")) {
        delete bundle[name];
      }
    }
  },
};

/*
 * The eagerly loaded monaco/VS Code core is Rollup's entry chunk (~15MB after
 * the base64-inlining fix below). Splitting it with manualChunks was attempted
 * and rejected: the monaco packages are one large re-export/import web, and
 * Rollup adds execution-order side-effect imports between manual chunks that
 * form cycles, which throw "Cannot access 'x' before initialization" at boot.
 * Splitting safely would require preserving native module boundaries
 * (preserveModules), so this remains the one file that needs
 * Organization.MaxUploadFileSize raised above the 5MB default.
 */

const HOSTABLE_ASSET_EXTENSIONS =
  /\.(?:js|mjs|css|html?|xml|txt|json|png|jpe?g|gif|ico|svg|resx|xap|xsl|xslt)$/i;

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
    // NOTE: don't use hash-free file names here - they break the bundled
    // webWorkerExtensionHostIframe.html (relative module specifiers stop
    // resolving).
    // Dataverse web resources support js/json(txt)/css/html/svg/png/... but
    // NOT `.wasm` or fonts. Keep only those unhostable binaries inline as
    // base64 data URLs; everything else must stay a separate asset (and thus
    // its own sub-5MB web resource).
    //
    // Inlining every asset under 1MB was the main cause of the 45MB entry
    // chunk: the monaco default extensions register their language-server
    // scripts/text via `new URL(...)`, and each of those got base64-inlined
    // (~34MB of data: URLs in the entry chunk alone). esbuild.wasm is shipped
    // as a separate gzip asset through webResourceWasmInline.
    assetsInlineLimit: (filePath, content) => {
      const assetPath = filePath.split("?")[0].toLowerCase();

      /*
       * Source maps are dropped entirely by dropSourceMapAssets; inlining
       * them here would put tens of MB of base64 back into the chunks.
       */
      if (assetPath.endsWith(".map")) {
        return false;
      }

      // No Dataverse web-resource type exists for wasm or fonts.
      if (assetPath.endsWith(".wasm") || /\.(woff2?|ttf|otf|eot)$/.test(assetPath)) {
        return true;
      }

      /*
       * Hostable types stay separate assets (and therefore separate web
       * resources). Everything else (README.md, .ts/.tmLanguage snippets,
       * ...) is unhostable, so embed it as a data URL like before; these are
       * all tiny text resources.
       */
      if (!HOSTABLE_ASSET_EXTENSIONS.test(assetPath)) {
        return true;
      }

      /*
       * Never inline JS/HTML/CSS resources: JS files can be imported
       * relatively by prebuilt extension modules or booted as workers, and
       * HTML is used for iframes. Collapse the many tiny JSON/text/icon
       * resources (d.ts files, package.json, codicons) into data URLs to
       * avoid hundreds of web-resource records.
       */
      if (/\.(?:js|mjs|html?|css)$/.test(assetPath)) {
        return false;
      }

      return content.length < 16 * 1024;
    },
  },
  worker: {
    format: "es",
    // Worker code is re-bundled with its own plugin list - share the textmate
    // main shim and the wasm inliner so workers resolve both virtual modules
    plugins: () => [textmateMainShim, webResourceWasmInline],
  },
  plugins: [
    webviewPreAssetsServe,
    webviewPreAssetsBuild,
    textmateMainShim,
    configureResponseHeaders,
    forcePreventTransformAssets,
    webResourceWasmInline,
    dropSourceMapAssets,
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
