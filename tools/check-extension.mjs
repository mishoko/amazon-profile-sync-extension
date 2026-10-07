// Static checks for the unpacked extension: node tools/check-extension.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const failures = [];
const fail = (msg) => failures.push(msg);

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
for (const key of ['name', 'version', 'action']) if (!manifest[key]) fail(`missing ${key}`);
for (const key of ['permissions', 'host_permissions', 'optional_permissions', 'background', 'content_scripts']) {
  if (key in manifest) fail(`unexpected ${key}: this milestone needs none`);
}

const pngSize = (file) => {
  const buf = readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};
const icons = { ...manifest.icons, ...Object.fromEntries(Object.entries(manifest.action.default_icon ?? {})) };
for (const [size, rel] of Object.entries(icons)) {
  const file = join(root, rel);
  if (!existsSync(file)) { fail(`missing icon ${rel}`); continue; }
  const [w, h] = pngSize(file);
  if (w !== +size || h !== +size) fail(`${rel} is ${w}×${h}, expected ${size}×${size}`);
}

// Every local reference in extension pages must resolve; nothing may load from the network.
const pages = [manifest.action.default_popup, ...['pages', 'dev'].flatMap((dir) =>
  readdirSync(join(root, dir)).filter((f) => f.endsWith('.html')).map((f) => `${dir}/${f}`))];
for (const rel of pages) {
  const file = join(root, rel);
  if (!existsSync(file)) { fail(`missing ${rel}`); continue; }
  const text = readFileSync(file, 'utf8');
  for (const [, ref] of text.matchAll(/(?:href|src)="([^"#?]+)/g)) {
    if (/^[a-z]+:/i.test(ref)) fail(`${rel} references remote URL ${ref}`);
    else if (!existsSync(join(dirname(file), ref))) fail(`${rel} references missing ${ref}`);
  }
  if (/\son[a-z]+=/i.test(text)) fail(`${rel} has an inline event handler`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) fail(`${rel} has an inline script`);
  if (/url\(\s*['"]?https?:/i.test(text)) fail(`${rel} loads a remote asset`);
}

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
// Links the user opens in a new tab. They are navigations, never fetched by the extension.
const navigationTargets = [/https:\/\/www\.amazon\$\{domain\}\/your-orders\/orders\?orderFilter=last30/g];
for (const file of walk(root).filter((f) => /\.(css|js|mjs|html)$/.test(f) && !f.includes('/tools/') && !f.includes('/.git/'))) {
  const text = navigationTargets.reduce((t, target) => t.replace(target, ''), readFileSync(file, 'utf8'));
  if (/https?:\/\//.test(text.replace(/xmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/g, ''))) {
    fail(`${file.slice(root.length + 1)} contains a URL`);
  }
}

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${manifest.name} ${manifest.version}: manifest valid, ${Object.keys(icons).length} icon entries, ${pages.length} pages, no permissions, no remote URLs except ${navigationTargets.length} allowed link target`);
