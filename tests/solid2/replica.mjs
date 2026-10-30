/*
 * Replicates the esbuild worker pipeline (manifests-only collection +
 * lazy rounds + package resolution) with the missingProbeCandidates(joined)
 * fix, against a real workspace. Verifies @solidjs/signals bundling works.
 */
import * as esbuildWasm from 'esbuild-wasm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const workspace = path.resolve(process.argv[2] ?? 'C:/projects/#test');
const entry = process.argv[3] ?? 'src/app.tsx';
const require = createRequire(import.meta.url);
const solidWasm = await import('@solidjs/compiler-wasm32-wasi').catch(() => null); // optional (post-revert)

/* collect like the worker: workspace sources (excl node_modules) + manifests */
const SOURCE_EXTS = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|json|css)$/;
const files = {};
const scanWorkspace = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.vscode'].includes(e.name) && rel === '') continue;
    if (e.isDirectory()) scanWorkspace(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    else if (SOURCE_EXTS.test(e.name)) files[rel ? `${rel}/${e.name}` : e.name] = fs.readFileSync(path.join(dir, e.name), 'utf8');
  }
};
scanWorkspace(workspace);
let manifests = [];
const scanManifests = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) scanManifests(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    else if (e.name.endsWith('package.json')) manifests.push(rel ? `${rel}/${e.name}` : e.name);
  }
};
scanManifests(path.join(workspace, 'node_modules'), 'node_modules');
for (const rel of manifests) files[rel] = fs.readFileSync(path.join(workspace, rel), 'utf8');
console.log(`init map: ${Object.keys(files).length} files (manifests ${manifests.length})`);

const readFromWorkspace = (relPath) => {
  try { return fs.readFileSync(path.join(workspace, relPath), 'utf8'); } catch { return null; }
};

const resolvableExts = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const indexTrails = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const absentPaths = new Set();
const missing = new Set();
let solidTransformCalls = 0;

function normalizePath(p) {
  const segs = [];
  for (const s of p.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') { segs.pop(); continue; }
    segs.push(s);
  }
  return segs.join('/');
}
function missingProbeCandidates(path) {
  const n = normalizePath(path);
  if (files[n] != null || absentPaths.has(n)) return;
  missing.add(n);
  const hasExt = /\.[a-z]+$/i.test(n);
  if (!hasExt) {
    for (const e of resolvableExts.slice(1)) { const c = n + e; if (!absentPaths.has(c)) missing.add(c); }
  }
  for (const t of indexTrails) { const c = n + t; if (!absentPaths.has(c)) missing.add(c); }
}

const lookup = (p) => {
  if (Object.hasOwn(files, p)) return p;
  const n = normalizePath(p);
  for (const e of resolvableExts.slice(1)) {
    if (Object.hasOwn(files, n + e)) return n + e;
  }
  for (const t of indexTrails) {
    if (Object.hasOwn(files, n + t)) return n + t;
  }
  return undefined;
};

function chooseExportTarget(manifest, subpath) {  const exp = manifest.exports ?? {};
  let node = subpath === '' ? exp['.'] : exp[`./${subpath}`];
  if (node == null && subpath !== '') return subpath; // fallthrough relative to pkg root
  if (node == null && subpath === '') {
    const fallback = typeof manifest.browser === 'string' ? manifest.browser : manifest.module ?? manifest.main;
    return typeof fallback === 'string' ? fallback : 'index.js';
  }
  const conds = ['browser', 'import', 'module', 'default'];
  const walk = (n) => {
    if (typeof n === 'string') return n;
    for (const c of conds) if (c in n) return walk(n[c]);
    return undefined;
  };
  return walk(node);
}

await esbuildWasm.initialize({ worker: false });

for (let round = 1; round <= 12; round++) {
  missing.clear();
  const result = await esbuildWasm.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'esnext',
    logLevel: 'silent',
    outbase: '.',
    outdir: 'out',
    plugins: [{
      name: 'replica-vfs',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (process.env.REPLICA_DEBUG) console.log('[resolve]', JSON.stringify(args.path), 'from', args.importer ?? '<entry>');
          if (args.path === entry) {
            if (files[entry] != null) return { path: entry, namespace: 'virtual' };
          }
          if (args.path.startsWith('.')) {
            const dir = args.importer?.includes('/') ? args.importer.split('/').slice(0, -1) : [];
            const joined = normalizePath([...dir, args.path].join('/'));
            if (lookup(joined) != null) return { path: lookup(joined), namespace: 'virtual' };
            if (process.env.REPLICA_DEBUG) console.log('[relative]', args.path, '| importer:', args.importer, '| joined:', joined, '| lookup:', lookup(joined));
            missingProbeCandidates(joined); // THE FIX
            return { path: joined, external: args.importer.includes('node_modules') }; // fallthrough
          }
          // bare
          const pkg = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
          const sub = args.path.slice(pkg.length + 1);
          const manifestRel = `node_modules/${pkg}/package.json`;
          if (files[manifestRel] == null) {
            missing.add(manifestRel);
            return { path: args.path, external: true };
          }
          const target = chooseExportTarget(JSON.parse(files[manifestRel]), sub);
          if (typeof target !== 'string') return { path: args.path, external: true };
          let candidate = normalizePath(`node_modules/${pkg}/${target.replace(/^\.\//, '')}`);
          for (const ext of resolvableExts) {
            if (lookup(candidate + ext) != null) return { path: candidate + ext, namespace: 'virtual' };
          }
          for (const trail of indexTrails) {
            if (lookup(candidate + trail) != null) return { path: candidate + trail, namespace: 'virtual' };
          }
          missingProbeCandidates(candidate);
          return { path: args.path, external: true };
        });

        build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
          const p = normalizePath(args.path);
          if (process.env.REPLICA_DEBUG && files[p] == null) {
            console.log('[load miss]', p, '| got keys sample:', Object.keys(files).filter(k => k.startsWith('src/')).join(','));
          }
          const raw = files[p];
          if (raw == null) return { errors: [{ text: `not in map: ${p}` }] };
          if (solidWasm && !p.startsWith('node_modules/') && (p.endsWith('.tsx') || p.endsWith('.jsx'))) {
            solidTransformCalls++;
            try {
              const out = solidWasm.transform(raw, { filename: p, moduleName: '@solidjs/web', generate: 'dom', dev: true, sourceMap: false });
              return { contents: out.code, loader: 'js' };
            } catch (e) { return { errors: [{ text: `[solid] ${p}: ${e}` }] }; }
          }
          const loader = p.endsWith('.json') ? 'json' : p.endsWith('.css') ? 'css' : ['.ts', '.mts', '.cts'].some(x => p.endsWith(x)) ? 'ts' : p.endsWith('.tsx') ? 'tsx' : p.endsWith('.jsx') ? 'jsx' : 'js';
          return { contents: raw, loader };
        });
      },
    }],
  }).catch((e) => ({ buildError: e.errors?.map((x) => x.text ?? x.detailText) ?? [String(e)] }));

  const requested = [...missing].filter((p) => files[p] == null && !absentPaths.has(p));
  if (result.buildError) {
    console.log(`round ${round}: build errors BEFORE finalize:`, result.buildError.slice(0, 3));
  }
  if (requested.length === 0) {
    console.log(`round ${round}: resolved, no more missing files`);
    if (!result.buildError) {
      const out = result.outputFiles?.[0];
      console.log(`OUTPUT ok: ${out?.text.length} chars; solid transforms: ${solidTransformCalls}`);
      console.log('imports:', [...new Set([...out.text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]))]);
    }
    break;
  }
  let added = 0;
  for (const rel of requested) {
    const text = readFromWorkspace(rel);
    if (text != null) { files[rel] = text; added++; } else absentPaths.add(rel);
  }
  console.log(`round ${round}: read ${added} of ${requested.length} requested`);
}
