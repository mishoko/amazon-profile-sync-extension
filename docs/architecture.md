# Architecture

Waybill is a browser extension (one per browser profile) and a small local
server. Everything they do is a list of named events, in one file:
[`core/events.js`](../core/events.js).

## Four ideas

1. **Events** (`core/events.js`): what follows what. Names are `who:what`:
   past tense when something happened (`user:signed-out`,
   `site:account-found`), imperative for work (`storage:save-account`).
   `then` lists events that all follow, in order. `oneOf` lists events of
   which exactly one follows; the event's handler picks it.
2. **Handlers**: the code for an event that does work, under the same name,
   in one of two files. The part before the colon says which:
   `server:` and `db:` are in `server/handlers.mjs`; everything else is in
   `background/handlers.js`.
3. **`emit()`** (`core/bus.js`): the only way parts talk. The popup and the
   Activity page call `emit('user:…')` and redraw from storage; they never
   write storage or talk to Amazon or the server. The background runs the
   chain, and hands server events to the server over one WebSocket
   (`background/server-link.js`). Both sides run chains with the same loop
   (`core/chain.js`).
4. **Integrations** (`integrations/`): one folder per marketplace, exporting
   the same six things (`id`, `name`, `sites`, `pageKind`, `checkAccount`,
   `readOrders`). Pages are read with two functions from
   `background/page-tools.js`.

```
 VIEWS (popup, Activity)            BACKGROUND (one per profile)              SERVER
 emit('user:…') ──runtime message──► storage: site: user: handlers ◄─WebSocket─► server: db: handlers ── PostgreSQL
 redraw when storage changes ◄────── core/state.js (the only writer)
                                     hidden page (only when an integration reads a page)
```

## Seeing what an event does

```sh
node tools/event-map.mjs                  # every chain, from what starts it
node tools/event-map.mjs user:signed-out  # what leads to an event, and everything it causes
```

```
user:signed-out
└─ storage:clear-session
   └─ storage:accounts-changed
      └─ storage:read-shared-accounts
         └─ db:replace-profile-accounts  [server]
            └─ server:send-all-accounts  [server]
               └─ storage:save-all-accounts
```

In development the background logs each event as it runs (`[waybill] …`
in its console).

## Sign-in and sign-out

| What happens | Started by | Chain |
| --- | --- | --- |
| Log in to Waybill | popup | `user:signed-in` → save session → share accounts → server list |
| Log out of Waybill | popup | `user:signed-out` → clear session → share `[]` → this profile's accounts leave every list |
| Sign in on Amazon | a tab leaves Amazon's `/ap/` pages | `site:signed-in` → `site:check-account` → found → save → share |
| Sign out on Amazon | a tab opens Amazon's sign-out page | `site:signed-out` → forget account → share (no request to Amazon) |
| Amazon wants the password again | a check or an orders read | `site:needs-sign-in` → mark the account → share |
| Amazon switched off | popup | `user:turned-off` → save settings → share (without Amazon) |

"Share" is `storage:accounts-changed` → `storage:read-shared-accounts` →
`db:replace-profile-accounts`. A profile always sends its whole list, never
a change, so nothing needs to be queued while the server is down: when a
profile connects, the server asks for the list again
(`server:profile-connected`).

## Adding a marketplace

1. A folder `integrations/<name>/` whose main module exports the six things
   listed in [`integrations/index.js`](../integrations/index.js).
2. One line in that list.
3. Its hosts in `manifest.json` (`node tools/check-extension.mjs` names any
   missing). Only if it reads pages rendered in a frame: its content-script
   matches, its reader in `web_accessible_resources`, and a frame rule.

A reader is a module in the integration's folder exporting
`read(document, location)`, returning plain data. `readFetchedPage(url,
reader)` reads the page as served; `readRenderedPage(url, reader)` reads it
after its own scripts ran, in an invisible frame of the hidden page. A
marketplace that needs neither never creates the hidden page.

A new behaviour is a new row in `core/events.js` and, if it does work, one
handler.

## The background can stop at any time

Chrome stops the background after about 30 seconds without activity and
starts it again for the next event.

- Everything that can wake it is registered at load
  (`background/background.js`): messages from the views, marketplace page
  loads, the reconnect alarm (every minute).
- Nothing that must outlive a stop is kept in memory. Sign-ins in
  progress, last check times, the server status and every profile's
  accounts are in `chrome.storage.session` (`core/state.js`).
- It stays awake only while it has a reason: connected to the server (a
  ping every 20 s), or while a chain runs (`core/bus.js`).
- Handlers are safe to run twice, and the server always receives whole
  lists, so a chain cut off by a stop is simply run again by its next
  trigger. A view waiting for an answer shows an error instead.

## Fail loud

- Real-world outcomes are events the user sees: `site:unreachable`,
  `site:needs-sign-in`, `server:account-offline`, `server:offline`.
- Everything else is a bug and stops with an error: an unknown event, a
  handler on the wrong side, a `oneOf` without a handler or with an outcome
  not in its list, an incomplete integration, a view writing storage or
  emitting anything but `user:`, a malformed message to the server. The
  table and handlers are checked when the background and the server start,
  and by `node tools/check-extension.mjs`. Views show errors in their
  `[data-error]` line.

## Configuration

Every number and address is in [`core/config.js`](../core/config.js), used
by the extension and the server. Moving the server to a VPS changes
`serverOrigin` there (and needs real authentication first; on 127.0.0.1 the
server trusts only the extension's origin).
