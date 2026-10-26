// Fail when a plugin's server or app source imports a file outside its plugin
// directory. bb's server rebuilds path-installed plugins from source and
// rejects such imports ("server source import escapes the plugin directory"),
// though a local `bb plugin build` accepts them (BBP-60). Tests are not
// bundled, so they may import across plugins.
//
// Usage, from a plugin directory: node ../../scripts/check-plugin-imports.mjs [pluginDir]
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const pluginDir = path.resolve(process.argv[2] ?? '.');
const pkg = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const entries = ['server', 'app', 'host'].map((k) => pkg.bb?.[k]).filter((v) => typeof v === 'string');
if (!entries.length) { console.log(`${pkg.name}: no server or app entry`); process.exit(0); }

const CODE = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
const SPECIFIERS = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g, // import x from '…', import '…', import type …
  /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,       // export … from '…'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                // import('…')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,               // require('…')
];
const inside = (file) => { const rel = path.relative(pluginDir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const isFile = (p) => existsSync(p) && statSync(p).isFile();
/** The source file a specifier names, trying the extensions the bundler would. */
function resolveFile(base) {
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  for (const c of [base, ...CODE.map((e) => stem + e), ...CODE.map((e) => path.join(base, 'index' + e))]) if (isFile(c)) return c;
  return null;
}
/** Blank out comments, keeping line numbers. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^(\s*)\/\/.*$/gm, '$1');

const problems = [];
const seen = new Set();
const queue = entries.map((e) => path.resolve(pluginDir, e));
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  if (!CODE.includes(path.extname(file))) continue;
  const src = stripComments(readFileSync(file, 'utf8'));
  for (const re of SPECIFIERS) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      let target;
      if (spec.startsWith('.') || path.isAbsolute(spec)) target = path.resolve(path.dirname(file), spec);
      else if (spec.startsWith('@/')) target = path.join(pluginDir, spec.slice(2)); // tsconfig paths: "@/*" → "./*"
      else continue; // a package or node: builtin
      const line = src.slice(0, m.index).split('\n').length;
      if (!inside(target)) { problems.push(`${path.relative(pluginDir, file)}:${line}: import escapes the plugin directory: ${spec}`); continue; }
      const resolved = resolveFile(target);
      if (resolved) queue.push(resolved);
    }
  }
}
if (problems.length) {
  console.error(`${pkg.name}: server and app sources may import only files inside the plugin directory (bb's server build rejects the rest):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`${pkg.name}: imports stay inside the plugin directory (${seen.size} files)`);
