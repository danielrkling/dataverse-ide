import { defineConfig, type Plugin } from 'vite'
import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin'
import * as fs from 'fs'
import path from 'path'

// For the *-language-features extensions (tsserver) which use SharedArrayBuffer
const configureResponseHeaders: Plugin = {
  name: 'configure-response-headers',
  apply: 'serve',
  configureServer (server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      next()
    })
  }
}

// Serve .html files raw, without vite transformation (e.g. the web worker
// extension host iframe which must run untouched in its sandboxed iframe)
const forcePreventTransformAssets: Plugin = {
  name: 'force-prevent-transform-assets',
  apply: 'serve',
  configureServer (server) {
    return () => {
      server.middlewares.use(async (req, res, next) => {
        if (req.originalUrl == null) {
          next()
          return
        }
        const pathname = new URL(req.originalUrl, import.meta.url).pathname
        if (!pathname.startsWith('/') || !pathname.endsWith('.html')) {
          next()
          return
        }
        const filePath = path.join(import.meta.dirname, pathname)
        if (!fs.existsSync(filePath)) {
          next()
          return
        }
        res.setHeader('Content-Type', 'text/html')
        res.writeHead(200)
        res.end(fs.readFileSync(filePath))
      })
    }
  }
}

export default defineConfig({
  // In Dataverse, assets are published as web resources under a path prefix,
  // e.g. DV_BASE=/webresources/dv_/ide
  base: process.env.DV_BASE ?? '/',
  resolve: {
    alias: [
      {
        // Optional xterm addon (dynamically imported by the terminal service
        // override) - its node builtin imports break the browser bundle, and
        // font-ligature shaping is irrelevant here
        find: /^@xterm\/addon-ligatures$/,
        replacement: path.resolve(import.meta.dirname, 'src/stubs/xtermLigatures.ts')
      }
    ]
  },
  build: {
    // monaco-vscode-api relies on dynamic imports of wasm / large chunks
    chunkSizeWarningLimit: 5000,
    target: 'es2022',
    sourcemap: false,
    // NOTE: don't add manualChunks or hash-free file names here - both
    // explode the module graph:
    //  - topical manualChunks cut through genuine dependency cycles in the
    //    monaco/VSCode sources ("Cannot access 'v' before initialization")
    //  - hash-free names break the bundled webWorkerExtensionHostIframe.html
    //    (relative module specifiers stop resolving)
    // The web resources don't support the `.wasm` type:
    // inline all binary assets (onig.wasm 466KB, diff_wasm_bg.wasm 118KB,
    // codicon.ttf 153KB) as base64 data URLs into the JS chunks instead
    assetsInlineLimit: 1000000
  },
  worker: {
    format: 'es'
  },
  plugins: [configureResponseHeaders, forcePreventTransformAssets],
  optimizeDeps: {
    exclude: ['@vscode/diff'],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin]
    }
  }
})
