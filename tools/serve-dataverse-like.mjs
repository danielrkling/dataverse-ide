#!/usr/bin/env node
/*
 * Serves dist/ the way Dataverse hosts it, so production builds can be tested
 * under production-like conditions instead of with `vite preview`.
 *
 * What it emulates:
 *   - the web-resource path prefix, e.g. /WebResources/dv_/ide/
 *   - NO Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers
 *     (Dataverse does not send them; the app's service worker synthesizes
 *     them for navigations after it takes control - that is what makes
 *     crossOriginIsolated flip from false to true on the second load)
 *   - X-Content-Type-Options: nosniff
 *   - Dataverse's JavaScript content type (application/x-javascript) by
 *     default; pass --js-mime=text/javascript for the "modern" variant
 *   - an optional CSP, including a preset that blocks blob: workers so the
 *     suspected Dataverse CSP failure mode can be reproduced
 *
 * What it does NOT emulate:
 *   - authentication / org redirects
 *   - HTTPS (http://<name>.localhost is a Chromium secure context, which is
 *     enough for the File System Access API and service workers)
 *   - Dataverse's real CSP, which is org-specific. Capture it from the real
 *     environment (F12 -> Network -> document response) and pass --csp-file.
 *
 * Usage:
 *   node tools/serve-dataverse-like.mjs
 *   node tools/serve-dataverse-like.mjs --port=5200 --csp=loose
 *   node tools/serve-dataverse-like.mjs --csp=no-blob-worker
 *   node tools/serve-dataverse-like.mjs --js-mime=text/javascript --isolate
 *
 * Then open the printed http://<name>.localhost:<port><prefix>/ URL.
 * Do NOT use 127.0.0.1 or localhost: public/pwa.js treats those as dev and
 * unregisters the service worker, so the production caching/isolation path
 * would not be exercised.
 */

import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "dist");

const args = new Map();

for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);

  if (match != null) {
    args.set(match[1], match[2] ?? "true");
  }
}

const port = Number(args.get("port") ?? 5199);

const prefixRaw = args.get("prefix") ?? "/WebResources/dv_/ide";
const prefix = `/${prefixRaw.replace(/^\/+|\/+$/g, "")}/`;

const jsMime = args.get("js-mime") ?? "application/x-javascript; charset=utf-8";
const cspMode = args.get("csp") ?? "none";
const cspFile = args.get("csp-file");
const isolate = args.has("isolate");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": jsMime,
  ".mjs": jsMime,
  ".cjs": jsMime,
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

const CSP_PRESETS = {
  none: undefined,

  /* Permissive: mirrors the iframe's own CSP plus same-origin assets. */
  loose: [
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'self' data: blob:",
    "connect-src 'self' data: blob: https: wss:",
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
  ].join("; "),

  /*
   * Reproduces the "Dataverse CSP does not allow blob: workers" failure.
   * The extension-host iframe and every Monaco/rolldown worker should fail.
   */
  "no-blob-worker": [
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data:",
    "worker-src 'self'",
    "child-src 'self'",
    "frame-src 'self' data:",
    "connect-src 'self' https: wss:",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
  ].join("; "),
};

const csp =
  cspFile != null
    ? await fs.readFile(path.resolve(cspFile), "utf8").then((text) => text.trim())
    : CSP_PRESETS[cspMode];

if (cspMode !== "none" && csp == null && cspFile == null) {
  console.error(
    `Unknown CSP mode "${cspMode}". Use none, loose, no-blob-worker, or --csp-file=<path>.`,
  );

  process.exit(1);
}

if (
  !(await fs
    .stat(distDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false))
) {
  console.error(`dist/ not found at ${distDir}. Run "npm run build" first.`);

  process.exit(1);
}

function resolveRequestPath(urlPath) {
  let decoded;

  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }

  /*
   * Dataverse/IIS is case-insensitive on the /WebResources/... prefix; asset
   * file names below it are matched exactly.
   */
  if (!decoded.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined;
  }

  let relative = decoded.slice(prefix.length);

  if (relative.length === 0 || relative.endsWith("/")) {
    relative += "index.html";
  }

  const absolute = path.resolve(distDir, relative);

  if (absolute !== distDir && !absolute.startsWith(`${distDir}${path.sep}`)) {
    return undefined;
  }

  return { absolute, relative };
}

function setCommonHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (csp != null) {
    response.setHeader("Content-Security-Policy", csp);
  }

  if (isolate) {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}

const server = createServer(async (request, response) => {
  const started = Date.now();
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/" || url.pathname === prefix.slice(0, -1)) {
    response.writeHead(302, { Location: prefix });
    response.end();

    return;
  }

  const resolved = resolveRequestPath(url.pathname);

  if (resolved == null) {
    setCommonHeaders(response);
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not a web-resource path. Expected ${prefix}\n`);

    console.log(`${request.method} ${url.pathname} -> 404 (outside prefix)`);

    return;
  }

  const stat = await fs.stat(resolved.absolute).catch(() => undefined);

  if (stat == null || !stat.isFile()) {
    setCommonHeaders(response);
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not found: ${resolved.relative}\n`);

    console.log(`${request.method} ${url.pathname} -> 404 (missing)`);

    return;
  }

  const extension = path.extname(resolved.absolute).toLowerCase();

  setCommonHeaders(response);

  response.setHeader("Content-Type", MIME_TYPES[extension] ?? "application/octet-stream");
  response.setHeader("Content-Length", stat.size);

  response.writeHead(200);

  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(resolved.absolute).pipe(response);
  }

  console.log(
    `${request.method} ${url.pathname} -> 200 ${extension || "(none)"} ${stat.size}B ` +
      `${Date.now() - started}ms`,
  );
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

server.listen(port, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address != null ? address.port : port;

  console.log("");
  console.log("Dataverse-like web-resource server");
  console.log(`  dist        ${distDir}`);
  console.log(`  prefix      ${prefix}`);
  console.log(`  js MIME     ${jsMime}`);
  console.log(`  CSP         ${cspMode}${cspFile ? ` (${cspFile})` : ""}`);
  console.log(`  COOP/COEP   ${isolate ? "ON (Vite-dev-like)" : "OFF (Dataverse-like)"}`);
  console.log("");
  console.log(`  http://dvide.localhost:${actualPort}${prefix}`);
  console.log("");
  console.log("Use dvide.localhost, not localhost/127.0.0.1: pwa.js treats those");
  console.log("as dev and unregisters the service worker.");
  console.log("");
});
