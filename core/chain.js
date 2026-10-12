// Runs events as core/events.js says, on one side: the extension's background
// or the server. Both use this same loop:
//   1. run the event's handler, if it has one;
//   2. follow `then`, or the one event the handler chose from `oneOf`;
//   3. hand events that run on the other side to passOn().
// A handler gets the chain's data; what it returns is added to it. A oneOf
// handler returns { event, data }. run() resolves with every event reached
// (here and on the other side) and its data, and rejects on any error.
import { EVENTS, whereIs, checkEvents } from './events.js';

export function createRunner({ side, handlers, passOn, log = () => {} }) {
  checkEvents();
  for (const name of Object.keys(handlers)) {
    if (!(name in EVENTS)) throw new Error(`Handler for unknown event "${name}"`);
    if (whereIs(name) !== side) throw new Error(`Handler for "${name}" belongs on the ${whereIs(name)}, not the ${side}`);
  }
  for (const [name, event] of Object.entries(EVENTS)) {
    if (whereIs(name) === side && event.oneOf && !handlers[name]) throw new Error(`"${name}" has oneOf but no handler on the ${side}`);
  }

  async function step(name, data, reached, context) {
    const event = EVENTS[name];
    if (!event) throw new Error(`Unknown event "${name}"`);
    if (whereIs(name) !== side) {
      Object.assign(reached, await passOn(name, data, context));
      return;
    }
    log(name);
    let next = event.then ?? [];
    let after = data;
    const handler = handlers[name];
    if (handler) {
      const result = await handler(data, context);
      if (event.oneOf) {
        if (!event.oneOf.includes(result?.event)) {
          throw new Error(`"${name}" must lead to one of ${event.oneOf.join(', ')}; its handler returned ${JSON.stringify(result?.event)}`);
        }
        next = [result.event];
        after = { ...data, ...result.data };
      } else if (result != null) {
        if (typeof result !== 'object' || Array.isArray(result)) throw new Error(`The handler for "${name}" must return an object or nothing`);
        after = { ...data, ...result };
      }
    }
    reached[name] = after;
    for (const nextName of next) await step(nextName, after, reached, context);
  }

  return {
    async run(name, data = {}, context = {}) {
      const reached = {};
      await step(name, data, reached, context);
      return reached;
    },
  };
}
