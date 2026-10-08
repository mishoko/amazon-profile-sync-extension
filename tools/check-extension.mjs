// Static checks for the unpacked extension: node tools/check-extension.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const failures = [];
const fail = (msg) => failures.push(msg);

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
for (const key of ['name', 'version', 'action']) if (!manifest[key]) fail(`missing ${key}`);
for (const key of ['optional_permissions', 'optional_host_permissions']) {
  if (key in manifest) fail(`unexpected ${key}: not needed yet`);
}
// storage: settings, session and this profile's Amazon account summaries.
// alarms: retry the local-server connection every minute.
// offscreen: the hidden document that parses Amazon pages and reads orders
//   in an invisible frame.
// declarativeNetRequestWithHostAccess: lets that frame show Amazon's orders
//   page (rules/orders-frame.json, checked below).
const allowedPermissions = ['storage', 'alarms', 'offscreen', 'declarativeNetRequestWithHostAccess'];
for (const permission of manifest.permissions ?? []) {
  if (!allowedPermissions.includes(permission)) fail(`unexpected permission ${permission}`);
}
// Amazon marketplace origins only: the popup reads each marketplace's session.
const amazonOrigin = /^https:\/\/www\.amazon\.[a-z.]+\/\*$/;
for (const origin of manifest.host_permissions ?? []) {
  if (!amazonOrigin.test(origin)) fail(`unexpected host permission ${origin}`);
}

// The manifest key pins the extension ID wherever the folder is loaded from.
// The server and compose.yaml must allow exactly that ID.
let extensionId = null;
if (!manifest.key) fail('missing key: the extension ID would depend on the folder path');
else {
  const der = Buffer.from(manifest.key, 'base64');
  extensionId = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  for (const file of ['server/server.mjs', 'compose.yaml']) {
    if (!readFileSync(join(root, file), 'utf8').includes(extensionId)) fail(`${file} does not allow the extension ID ${extensionId}`);
  }
}

// The extension, the server and compose.yaml must agree on the server port.
const extensionPort = readFileSync(join(root, 'lib/server.js'), 'utf8').match(/SERVER_ORIGIN = 'http:\/\/127\.0\.0\.1:(\d+)'/)?.[1];
const serverPort = readFileSync(join(root, 'server/server.mjs'), 'utf8').match(/DEFAULT_PORT = (\d+)/)?.[1];
const composePorts = [...readFileSync(join(root, 'compose.yaml'), 'utf8').matchAll(/WAYBILL_PORT:-(\d+)/g)].map((match) => match[1]);
if (!extensionPort || extensionPort !== serverPort || !composePorts.length || composePorts.some((port) => port !== extensionPort)) {
  fail(`server port mismatch: extension ${extensionPort}, server ${serverPort}, compose ${composePorts.join('/')}`);
}

// Content scripts: only Amazon's orders, sign-in and error pages; they act only
// inside the extension's own invisible frame (content/orders-frame.js).
const contentPage = /^https:\/\/www\.amazon\.[a-z.]+\/(your-orders|ap|errors)\/\*$/;
for (const script of manifest.content_scripts ?? []) {
  for (const match of script.matches) if (!contentPage.test(match)) fail(`content script matches ${match}`);
  for (const file of script.js ?? []) if (!existsSync(join(root, file))) fail(`missing content script ${file}`);
}

// Network rules: only removing the two framing headers, only for frames this
// extension itself loads, only on Amazon.
for (const { path } of manifest.declarative_net_request?.rule_resources ?? []) {
  if (!existsSync(join(root, path))) { fail(`missing rules ${path}`); continue; }
  for (const rule of JSON.parse(readFileSync(join(root, path), 'utf8'))) {
    const { action, condition } = rule;
    const headers = action.responseHeaders ?? [];
    const narrow = action.type === 'modifyHeaders' && !action.requestHeaders
      && headers.length && headers.every(({ header, operation }) => operation === 'remove' && ['x-frame-options', 'content-security-policy'].includes(header))
      && JSON.stringify(condition.resourceTypes) === '["sub_frame"]'
      && JSON.stringify(condition.initiatorDomains) === JSON.stringify([extensionId])
      && condition.requestDomains?.length && condition.requestDomains.every((domain) => /^www\.amazon\.[a-z.]+$/.test(domain));
    if (!narrow) fail(`${path} rule ${rule.id} is broader than removing framing headers for this extension's Amazon frames`);
  }
}

const worker = manifest.background?.service_worker;
if (worker && !existsSync(join(root, worker))) fail(`missing service worker ${worker}`);

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
const pages = [manifest.action.default_popup, ...['pages', 'dev', 'activity', 'background'].flatMap((dir) =>
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

// Extension files only: tools/ and server/ run in Node, not in the browser.
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
// The Amazon marketplace origin template (covered by host_permissions), the
// OpenID identifiers Amazon's sign-in URL carries as parameters (never fetched),
// and the local Waybill server on the loopback interface.
const navigationTargets = [/https:\/\/www\.amazon\$\{domain\}/g, /http:\/\/specs\.openid\.net\/auth\/2\.0(?:\/identifier_select)?/g, /http:\/\/127\.0\.0\.1:4417/g];
for (const file of walk(root).filter((f) => /\.(css|js|mjs|html)$/.test(f) && !/\/(tools|server|\.git)\//.test(f))) {
  const text = navigationTargets.reduce((t, target) => t.replace(target, ''), readFileSync(file, 'utf8'));
  if (/https?:\/\//.test(text.replace(/xmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/g, ''))) {
    fail(`${file.slice(root.length + 1)} contains a URL`);
  }
}

// Every extension script must parse as a JavaScript module (catches syntax
// errors before the browser does).
const scripts = walk(root).filter((f) => /\.js$/.test(f) && !/\/(tools|server|\.git|node_modules)\//.test(f));
for (const file of scripts) {
  const { status, stderr } = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: readFileSync(file) });
  if (status !== 0) fail(`${file.slice(root.length + 1)} has a syntax error: ${String(stderr).split('\n').find((line) => /Error/.test(line))}`);
}

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${manifest.name} ${manifest.version} (ID ${extensionId}, server port ${extensionPort}): manifest valid, ${Object.keys(icons).length} icon entries, ${pages.length} pages, ${scripts.length} scripts parse, permissions [${manifest.permissions ?? []}], ${manifest.host_permissions?.length ?? 0} Amazon host permissions, no other remote URLs`);
