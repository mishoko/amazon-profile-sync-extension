// Prints the event map from core/events.js.
//   node tools/event-map.mjs                    every chain, from what starts it
//   node tools/event-map.mjs <event>            what leads to <event>, and everything it causes
// [server] marks events that run on the server; everything else runs in the
// extension's background. "one of" marks a choice made by the event's handler.
import { EVENTS, whereIs } from '../core/events.js';

const next = (name) => EVENTS[name].then ?? EVENTS[name].oneOf;
const label = (name) => (whereIs(name) === 'server' ? `${name}  [server]` : name);

function causes(name, indent = '', lines = []) {
  const event = EVENTS[name];
  const targets = next(name);
  targets.forEach((target, index) => {
    const last = index === targets.length - 1;
    const branch = event.oneOf ? (last ? '└┄ ' : '├┄ ') : (last ? '└─ ' : '├─ ');
    lines.push(`${indent}${branch}${label(target)}`);
    causes(target, indent + (last ? '   ' : '│  '), lines);
  });
  return lines;
}

function leadsHere(name, path = [name], lines = []) {
  const sources = Object.keys(EVENTS).filter((candidate) => next(candidate).includes(name));
  if (!sources.length) lines.push(path.map(label).reverse().join('  →  '));
  for (const source of sources) leadsHere(source, [...path, source], lines);
  return lines;
}

const asked = process.argv[2];
if (asked) {
  if (!(asked in EVENTS)) {
    console.error(`Unknown event "${asked}". Events: ${Object.keys(EVENTS).join(', ')}`);
    process.exit(1);
  }
  console.log(`${label(asked)}\n\nWhat leads here:\n${leadsHere(asked).map((line) => `  ${line}`).join('\n')}`);
  console.log(`\nWhat it causes${EVENTS[asked].oneOf ? ' (├┄ one of)' : ''}:\n${causes(asked).map((line) => `  ${line}`).join('\n') || '  nothing'}`);
} else {
  const targets = new Set(Object.values(EVENTS).flatMap((event) => event.then ?? event.oneOf));
  for (const start of Object.keys(EVENTS).filter((name) => !targets.has(name))) {
    console.log(`${label(start)}\n${causes(start).join('\n')}\n`);
  }
  console.log('├─ then (all, in order)   ├┄ oneOf (exactly one)   [server] runs on the server');
}
