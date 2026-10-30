/*
 * Headless replay of the IDE's esbuild worker pipeline against a real
 * workspace folder (default: C:/projects/#test):
 *   collect workspace files + node_modules manifests -> Solid wasm transform
 *   on .tsx/.jsx workspace files -> esbuild-wasm bundling with package
 *   resolution (browser conditions) over the flat node_modules.
 * Usage: node harness.mjs [workspaceDir] [entryRelativePath]
 */
import * as esbuildWasm from 'esbuild-wasm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transform as solidTransform } from '@solidjs/compiler-wasm32-wasi';

const workspaceDir = path.resolve(process.argv[2] ?? 'C:/projects/#test');
const entry =
  process.argv[3] ??
  (() => {
    // fallback: pick src/*.tsx|ts like the IDE
    const src = path.join(workspaceDir, 'src');
    const candidates = ['src/app.tsx', 'src/index.tsx', 'src/main.tsx', 'src/app.ts', 'src/index.ts'];
    for (const c of candidates) if (fs.existsSync(path.join(workspaceDir, c))) return c;
    throw new Error('no entry found');
  })();

/* ---- collect files like collectWorkspaceSources ---- */
const SOURCE_EXTS = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|json|css)$/;
const files = {};
const collect = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (rel === '' && (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.vscode')) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collect(abs, r);
    else if (SOURCE_EXTS.test(r)) {
      // collect manifests anywhere, sources only outside node_modules
      if (r.startsWith('node_modules/') && !r.endsWith('package.json')) continue;
      if (files[r] == null) files[r] = fs.readFileSync(abs, 'utf8');
    }
  }
};
// collect src + root config files + node_modules package.json manifests
for (const e of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
  if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== '.git' && e.name !== '.vscode') {
    collect(path.join(workspaceDir, e.name), e.name);
  } else if (!e.isDirectory() && SOURCE_EXTS.test(e.name)) {
    files[e.name] = fs.readFileSync(path.join(workspaceDir, e.name), 'utf8');
  }
}
// node_modules manifests + files proven needed later (lazy rounds like the worker)
const nodeModulesManifests = [];
const walkNm = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkNm(abs, r);
    else if (r.endsWith('package.json')) nodeModulesManifests.push(r);
  }
};
walkNm(path.join(workspaceDir, 'node_modules'), 'node_modules');
for (const rel of nodeModulesManifests) {
  if (nodeModulesManifests.length < 3000) files[rel] = fs.readFileSync(path.join(workspaceDir, rel), 'utf8');
}
console.log(`collected ${Object.keys(files).length} files (manifests: ${nodeModulesManifests.length})`);

/* ---- Solid transform (same options as the worker) ---- */
const solidCompile = (code, filename, { dev = true, sourcemap = false } = {}) =>
  solidTransform(code, {
    filename,
    moduleName: '@solidjs/web',
    generate: 'dom',
    dev,
    sourceMap: sourcemap,
  });

/* ---- package resolver: browser conditions (mirrors worker semantics) ---- */
const conditions = ['browser', 'import', 'module', 'default']; // worker order
function resolveExportTarget(pkgDir, target, lookup) {
  let candidate = path.posix.normalize(`${pkgDir}/${target.replace(/^\.\//, '')}`);
  const tryList = (p) => {
    const base = p.replace(/\\/g, '/');
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.json']) {
      if (lookup(`${base}${ext}`) != null) return `${base}${ext}`.replace(/\\/g, '/');
    }
    for (const trail of ['/index.ts', '/index.tsx', '/index.js']) {
      if (lookup(`${base}${trail}`) != null) return `${base}${trail}`;
    }
    return undefined;
  };
  let hit = tryList(candidate);
  if (hit == null && /\.(json|ts|js|jsx|tsx|mjs|cts|mts)$/.test(base1(candidate))) return undefined;
  return hit;
}
const base1 = (p) => p; // helper no-op

/* ---- build with esbuild-wasm (node): same plugin shape as worker ---- */
/* wrapper mimicking a realistic app entry (user files untouched) */
files['src/__harness__.tsx'] = `import { App } from './app';
import { createSignal } from 'solid-js';
import { For } from 'solid-js';

export default function Harness() {
  const [count, setCount] = createSignal(0);
  return (
    <div class="harness" onClick={() => setCount(count() + 1)}>
      <App />
      <For each={[1, 2]}>{(n) => <em>{n}</em>}</For>
      <button disabled={count() > 3}>Count: {count()}</button>
    </div>
  );
}
`;

await esbuildWasm.initialize({ worker: false });
const lookup = (p) => (Object.hasOwn(files, p) ? p : undefined);

const needMore = new Set();
const absent = new Set();

const result = await esbuildWasm.build({
  // wrapper so something actually graph-depends on App + solid-js
  entryPoints: ['src/__harness__.tsx'],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'esnext',
  logLevel: 'silent',
  outbase: '.',
  outdir: 'out',
  plugins: [
    {
      name: 'headless-vfs',
      setup(build) {
        build.onResolve({ filter: /.*/ }, async (args) => {
          if (
            args.path === entry ||
            args.path === 'src/__harness__.tsx' ||
            args.path.startsWith('/')
          ) {
            const p = normalize(args.path === entry ? entry : args.path);
            if (lookup(p) != null) return { path: p, namespace: 'virtual' };
            for (const ext of ['.tsx', '.ts', '.jsx', '.js']) if (lookup(p + ext) != null) return { path: p + ext, namespace: 'virtual' };
          }
          if (args.path.startsWith('.')) {
            const importer = args.importer.split('/').slice(0, -1);
            const p = normalize([...importer, args.path].join('/'));
            for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.json']) {
              if (lookup(`${p}${ext}`) != null) return { path: `${p}${ext}`, namespace: 'virtual' };
            }
          }
          // configured externals: none here
          // bare imports: package resolution with browser conditions
          const spec = args.path;
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          const sub = spec.slice(pkg.length + 1);
          const manifestRel = `node_modules/${pkg}/package.json`;
          if (files[manifestRel] == null) return { path: spec, external: true };
          const manifest = JSON.parse(files[manifestRel]);
          const exports = manifest.exports ?? {};
          let target = sub === '' ? exports['.'] : exports[`./${sub}`];
          if (target == null && sub !== '') {
            // subpath fallthrough: package root -> sub path
            target = sub;
          }
          if (target == null && sub === '') {
            const fallback = manifest.browser?.[0] ?? manifest.browser ?? manifest.module ?? manifest.main;
            target = typeof fallback === 'string' ? fallback : 'index.js';
          }
          let resolvedPath;
          const walk = (node) => {
            if (typeof node === 'string') return node;
            if (node == null) return undefined;
            for (const c of conditions) if (c in node) return walk(node[c]);
            return undefined;
          };
          const chosen = walk(target);
          if (typeof chosen === 'string') {
            const t = chosen.replace(/^\.\//, '');
            let candidate = path.posix.normalize(`node_modules/${pkg}/${t}`);
            for (const ext of ['', '.js', '.mjs', '.json']) {
              if (lookup(candidate + ext) != null) { resolvedPath = candidate + ext; break; }
            }
            if (resolvedPath == null && !/\.[a-z]+$/.test(candidate)) {
              for (const trail of ['/index.js', '/index.mjs']) {
                if (lookup(candidate + trail) != null) { resolvedPath = candidate + trail; break; }
              }
            }
          }
          if (resolvedPath != null) {
            if (files[resolvedPath] == null) needMore.add(resolvedPath);
            return { path: resolvedPath, namespace: 'virtual' };
          }
          return { path: spec, external: true };
        });

        build.onLoad({ filter: /.*/, namespace: 'virtual' }, async (args) => {
          const p = args.path.replace(/\\/g, '/');
          const raw = files[p];
          if (raw == null) return { errors: [{ text: `not collected: ${p}` }] };
          if (!p.startsWith('node_modules/') && (p.endsWith('.tsx') || p.endsWith('.jsx'))) {
            try {
              const compiled = solidCompile(raw, p, { dev: true });
              return { contents: compiled.code, loader: 'js' };
            } catch (e) {
              return { errors: [{ text: `[solid] ${p}: ${e instanceof Error ? e.message : String(e)}` }] };
            }
          }
          return { contents: raw, loader: getLoader(p) };
        });
      },
    },
  ],
});

function normalize(p) {
  const segs = [];
  for (const s of p.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') { segs.pop(); continue; }
    segs.push(s);
  }
  return segs.join('/');
}
function getLoader(p) {
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.css')) return 'css';
  if (p.endsWith('.tsx')) return 'tsx';
  if (p.endsWith('.jsx')) return 'jsx';
  if (p.endsWith('.ts') || p.endsWith('.mts') || p.endsWith('.cts')) return 'ts';
  return 'js';
}

const warnings = result.warnings.map((w) => w.text);
const externals = warnings.filter((w) => /Could not resolve|RESOLV/.test(w));
console.log('--- warnings:', warnings.length);
console.log(warnings.join('\n').slice(0, 2000));
console.log('--- outputs:', result.outputFiles.map((f) => ({ path: f.path, size: f.text.length })));
const code = result.outputFiles[0].text;
const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
console.log('--- external imports:', [...new Set(imports)]);
console.log('--- residual JSX in output (outside templates):', /<[a-z]+[\s>]/.test(code.replace(/`[^`]*`/g, '')));

