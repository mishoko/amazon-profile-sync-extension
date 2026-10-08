# Waybill Profile Aggregator

> 📹 **Demo video:** [watch the walkthrough](VIDEO_LINK_PLACEHOLDER) *(link coming soon)*

Waybill is a browser extension and a small local server that bring
together the Amazon accounts you are signed into across **several browser
profiles**, and show each account's real orders in one place. You don't
need to switch profiles, sign in again, or copy anything by hand.

Each browser profile keeps its own Amazon sign-in, which the browser
deliberately keeps separate from your other profiles. Waybill runs inside
each profile, reports which Amazon accounts are signed in there, and, only
when you ask, reads that account's orders from Amazon in the profile that
holds the sign-in. The result is a single Activity page listing every
account from every profile, with live order history.

> **Acknowledgement.** Waybill is an alternative variant built with the
> agreement of the Trackerbot team. It reuses the existing Trackerbot
> extension's user interface (layout and interaction patterns) under its own
> name and icons. The code is written independently.

---

## Contents

- [Use cases](#use-cases)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Using the extension](#using-the-extension)
- [Technologies and why each one is used](#technologies-and-why-each-one-is-used)
- [Data model](#data-model)
- [Extension permissions](#extension-permissions)
- [Privacy and security](#privacy-and-security)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Scope of this release](#scope-of-this-release)
- [Next steps](#next-steps)
- [License](#license)

---

## Use cases

1. **One view for many buyer accounts.** A dropshipping operator buys for
   customers from several Amazon accounts, each kept in its own browser
   profile so the sessions never mix. Waybill lists all of them in any one
   profile and opens any account's orders without switching profiles.
2. **Checking an old or secondary account.** An alternate account that is
   rarely used still has orders from previous years. Select it in Activity
   and pick the year; the orders are read live from Amazon in the profile
   that is signed into it.
3. **Several marketplaces, one place.** The same person buys on
   amazon.com and amazon.co.uk. Each marketplace appears as its own entry
   with its own orders, order numbers, totals and delivery status.
4. **Keeping the list tidy.** An account that no longer matters can be
   removed with one click. It stays removed even if a profile is still
   signed into it, and comes back only if you sign in to it again.

## Features

All of the following are implemented and working:

**Browser extension (Manifest V3)**
- Popup with the familiar layout: a signed-out screen, then Amazon and
  AliExpress cards, "Go to account", "Activity" and "Log out".
- Amazon marketplace selector for all 11 supported sites (.com, .ca,
  .co.uk, .com.au, .de, .es, .fr, .ie, .it, .ae, .sa). The switches, the
  selected site and the expanded state are remembered.
- Live connection check. For the selected site the popup shows **Active**
  and the signed-in account's email, or **Log in** and **Inactive** when no
  account is signed in or Amazon wants the password again.
- "Log in" opens Amazon's own sign-in for the chosen marketplace. Waybill
  never sees or stores a password.
- Background sign-in tracking. Signing out of Amazon removes the account
  immediately, and finishing a sign-in adds it, without opening the popup.
- Sharing follows your choices. A profile shares its accounts only while
  you are signed in to Waybill and Amazon is switched on. Logging out or
  switching Amazon off removes them from every list straight away.
- Same ID everywhere. The extension ID is pinned in the manifest, so every
  installation, from any folder, is recognised by the server.

**Activity page**
- Lists the Amazon accounts of **every browser profile** running Waybill,
  labelled "This browser profile" or "Another browser profile".
- Orders are loaded **on demand**, only when you select an account. Waybill
  starts from Amazon's default period, or the most recent year that has
  orders, and offers a period selector for other years.
- Each order shows the order date, total, order number (linked to Amazon),
  delivery status, and items with title, link and picture, on every
  supported marketplace, including the non-English ones.
- Every load shows its source, for example *"Read live from Amazon in another
  browser profile at 21:32:51 in 2.8 s"*, with a **Refresh** button.
- The list updates live, without reloading the page, when a profile signs in
  or out, connects or disconnects.
- Each account has a lasting ID (for example `activity.html?type=amazon&id=3`),
  so a link always reopens the same account.
- Accounts can be removed (soft delete, after a confirmation).
- Without the server, the page falls back to the current profile's accounts
  and reconnects automatically when the server returns.

**Server and database**
- A small Node.js server that joins all profiles: account registration, live
  push to open Activity pages, and routing of order requests to the right
  profile.
- PostgreSQL storage for profiles and accounts (never orders), with
  migrations applied automatically.
- One-command start with Docker Compose. The server is reachable only from
  this machine and accepts only the Waybill extension.
- Self-maintaining data:
  - account links exist only while a profile is connected, so they can't
    go stale;
  - profiles unseen for 30 days are removed automatically;
  - orders are read in a hidden page, so no window ever opens.
- Built-in consistency checks: one command verifies that the extension ID,
  server port and Compose settings agree, and that every extension script
  parses.

## How it works

```
 Browser profile A                        Browser profile B
┌──────────────────────────┐             ┌──────────────────────────┐
│ Waybill extension        │             │ Waybill extension        │
│  popup · Activity page   │             │  popup · Activity page   │
│  background worker ──────┼─WebSocket─┐ ┌─┼── background worker   │
│  (Amazon session of A)   │           │ │ │  (Amazon session of B)   │
└──────────────────────────┘           ▼ ▼ └──────────────────────────┘
                              ┌────────────────────┐
                              │ Waybill server     │  127.0.0.1:4417
                              │ (Node.js, Docker)  │
                              └─────────┬──────────┘
                                        │
                              ┌─────────▼──────────┐
                              │ PostgreSQL         │  profiles, accounts
                              └────────────────────┘
```

1. Each profile's background worker connects to the server and reports the
   Amazon accounts signed in there: marketplace, Amazon customer ID, name,
   and status.
2. The Activity page, in any profile, receives the combined list and stays
   subscribed to changes.
3. When you select an account, the server asks the profile that holds it to
   read the orders. That profile loads Amazon's orders page invisibly, in
   a hidden frame of the extension's background page, waits for Amazon to
   finish rendering it, reads the orders and sends the result back. No
   window or tab opens. Nothing about the
   orders is stored.

## Requirements

| Requirement | Version | Used for |
| --- | --- | --- |
| A Chromium-based browser (Google Chrome, Brave, Microsoft Edge) | 116 or newer | Running the extension |
| Docker Desktop (or Docker Engine with Compose v2) | Compose v2 | Running the server and PostgreSQL |
| Node.js | 22 or newer | *Optional:* running the server without Docker, and the tests |
| An Amazon account on at least one supported marketplace | — | Something to aggregate |

Tested on macOS with Brave and Chrome for Testing.

## Getting started

### 1. Get the code

```sh
git clone <repository-url> waybill
cd waybill
```

### 2. Start the server and database

```sh
cp .env.example .env
# edit .env and set POSTGRES_PASSWORD to a password of your choice
docker compose up -d --build
```

This starts two containers:
- **server**: listening on `127.0.0.1:4417`;
- **db**: PostgreSQL 17, also published on `127.0.0.1:5433` for inspection
  with `psql`.

The database schema is created on first start. To check that it's running:

```sh
docker compose ps
docker compose logs server     # "Store: Postgres" and "listening on 0.0.0.0:4417"
```

To stop it: `docker compose down`. Your data stays in the `db-data` volume;
`docker compose down -v` also deletes the data.

*Without Docker:* `node server/server.mjs` runs the same server with an
in-memory store. Everything works, but the list starts empty after each
restart.

### 3. Install the extension (developer mode)

Waybill is not yet published in the Chrome Web Store, so it is installed as
an unpacked extension:

1. Open `chrome://extensions` (Brave: `brave://extensions`, Edge:
   `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder: the one containing
   `manifest.json`.
4. Click the puzzle-piece icon in the toolbar and pin **Waybill**.

Repeat for every browser profile whose Amazon accounts you want to include.
The extension always has the same ID, `dmhkjckieepnigmelmogkmomgmkgkkdn`,
whichever folder it is loaded from (the manifest pins it), and that is the
ID the server accepts.

After pulling new code, click the reload icon on Waybill's card on the
extensions page.

## Using the extension

1. **Sign in to Waybill.** Click the toolbar icon, then **Log in**. There is
   no Waybill account service yet, so in developer installs this sign-in is
   simulated: it uses no account and sends nothing.
2. **Turn on Amazon.** Switch Amazon on, expand the card with the chevron and
   pick the marketplace you're signed into. The connection shows **Active**
   with the account, or **Log in** if Amazon wants you to sign in. "Log in"
   opens Amazon's own sign-in page.
3. **Open Activity.** Click **Activity**. You'll see every account from every
   connected profile. Select one to load its orders, change the **Period**
   to see other years, or **Refresh** to read them again.
4. **Remove an account** with the **×** on its card (shown when the server is
   running). It comes back only after a new sign-in to that account.

Keep each browser profile open, so its background worker stays connected
and can serve its accounts' orders.

## Technologies and why each one is used

### Browser extension: Manifest V3, plain HTML, CSS and JavaScript modules

The only component that can use your Amazon sign-in is something running
**inside** your browser profile, with your permission. A browser extension
is exactly that.

- **Manifest V3** is the current, required extension platform for Chromium
  browsers and their stores.
- **Native JavaScript modules**, with no framework and no build step: the
  interface is small, the code loads directly as written (easy to review
  and to publish), and there is nothing to compile or keep updated.
- A **background service worker** keeps the profile connected to the server
  and follows Amazon sign-ins and sign-outs.
- An **offscreen document**, Chrome's hidden extension page for background
  work that needs a page, does two jobs:
  - it parses Amazon pages for the background sign-in check (service
    workers cannot use the browser's HTML parser);
  - it reads orders. Amazon sends order details encrypted inside the
    orders page, and its own scripts decrypt them in the browser, so the
    orders only exist once the real page has run. Waybill loads that page
    in a frame of the offscreen document, which is never displayed, and a
    read-only script reads the finished page.

### Server: Node.js, HTTP and WebSockets

Browser profiles are isolated by design: an extension in one profile
**cannot** see another profile's sign-ins, storage or extension, and
profiles cannot message each other. A combined view therefore needs
something outside all of them that each one can reach. That is the
server's job:

- **Registry:** collects the account details each profile reports.
- **Live updates:** pushes the combined list to every open Activity page.
- **Router:** sends an order request to the profile that holds that account,
  and returns the answer. Orders are passed through, not kept.

Without the server, each profile still works on its own: its popup and
Activity page show only its own accounts.

**Why WebSockets:** the server must *push* requests to a profile (for
example "read the orders of account 3") and push list changes to open
pages. A WebSocket is a lasting two-way channel. It is also the documented
way for a Manifest V3 background worker to stay alive while connected.

**Why Node.js:** the server is a small, event-driven message router. Node
handles many lasting connections well, and the server needs only one
library (the PostgreSQL driver); HTTP and WebSockets use Node's standard
library.

### Database: PostgreSQL

The server needs to remember who and what it has seen, beyond a single run.
PostgreSQL provides that:

- **Lasting identities.** Every account gets a permanent numeric ID that
  survives server restarts and reconnects, so links and future history can
  refer to it.
- **Relationships with guarantees.** Profiles and accounts are
  many-to-many: one account can be signed in on several profiles, and one
  profile holds several accounts. Foreign keys and unique constraints
  enforce "one row per Amazon account per marketplace" in the database
  itself, not just in code.
- **Safe concurrent writes.** Several profiles report at the same time.
  Transactions and per-marketplace locks prevent duplicate accounts.
- **Auditability.** Removal is a soft delete (`deleted_at`). Creation,
  update and last-seen times are recorded.
- **Room to grow.** The natural next steps are order history, shipment
  tracking events and several users: time-ordered, relational and
  query-heavy data. PostgreSQL handles these without a change of database,
  with versioned migrations already in place.

A single-file database (SQLite) would also work for one person on one
machine. PostgreSQL was chosen because the same setup carries over to a
hosted, multi-user deployment.

### Docker and Docker Compose

- **One command** (`docker compose up`) starts the server and the database,
  wired together, with the right versions.
- **Reproducible:** the same Node and PostgreSQL versions on every machine.
- **Contained:** the server runs as a non-root user with a read-only
  filesystem and no extra privileges. Ports are published on `127.0.0.1`
  only, never on your network.
- **Clean project folder:** the PostgreSQL driver is installed only inside
  the image. The browser loads the project folder as the extension, so
  keeping `node_modules` out of it keeps the extension small and loadable.

## Data model

```
profiles 1───* profile_accounts *───1 accounts
```

| Table | One row per | Key columns |
| --- | --- | --- |
| `profiles` | Browser profile with Waybill installed (its random instance ID) | `id`, `first_seen_at`, `last_seen_at` |
| `accounts` | Amazon account **on one marketplace** | `id` (lasting), `marketplace`, `domain`, `customer_id`, `email`, `name`, `deleted_at` |
| `profile_accounts` | Account held by a **connected** profile right now | `profile_id`, `account_id`, `status` (`active` / `needs-sign-in`), `reported_at` |

Why this shape:
- **Accounts are separate from profiles** because the same Amazon account
  can be signed in on several profiles, while it must keep one identity.
- **One account row per marketplace**, because Amazon keeps a separate
  order history per marketplace, even for the same customer.
- **Status lives on the link**, because it is per profile: an account can
  be signed in on one profile while another needs the password again.
- **Links last only while the profile is connected.** They are removed when
  a profile disconnects and cleared when the server starts, so the table
  always describes the present. Accounts and their IDs are permanent.
  Profile rows are kept for 30 days after they were last seen.
- **Matching is by Amazon's customer ID**, falling back to email while the
  ID is not yet known, so the same account is never stored twice.
- **Orders are not stored.** They are read live, on request.

Schema files: [`server/migrations/`](server/migrations).

## Extension permissions

| Permission | Why it is needed |
| --- | --- |
| Host access to the 11 `www.amazon.*` sites | Read your sign-in state and orders on those sites, and nothing else |
| `storage` | Remember switches, the selected marketplace, and this profile's account summaries |
| `offscreen` | The hidden background page that checks sign-in state and reads orders, invisibly |
| `declarativeNetRequestWithHostAccess` | Lets that hidden page show Amazon's orders page in a frame. A single rule removes Amazon's "don't show me in a frame" headers, only for frames Waybill itself loads, only on the 11 Amazon sites. |
| `alarms` | Retry the server connection once a minute when the server is down |

Waybill's page script is declared for Amazon's orders, sign-in and error
pages. It acts only inside Waybill's own hidden frame and does nothing on
pages you browse. There is no access to other websites, and the extension
contains no remote code.

To watch a read happen live: on the extensions page, open Waybill's
**Details**, click **Inspect views: background/offscreen.html**, and keep
DevTools' **Network** tab open while you select an account in Activity.

## Privacy and security

- Waybill never sees, asks for or stores Amazon passwords or cookies. It
  uses the browser's existing sign-in, the way a page you open would.
- Orders are read only when you ask and are never stored, neither in the
  extension nor on the server.
- The server keeps only account summaries (marketplace, Amazon customer ID,
  name, email, status) and runs on your machine. It listens on `127.0.0.1`,
  accepts only Waybill's extension origin, and rejects other host names, so
  websites in your browser cannot use it.
- PostgreSQL is reachable only on `127.0.0.1`, with the password you set in
  `.env`.

## Project structure

| Path | Contents |
| --- | --- |
| `manifest.json` | Extension manifest: name, permissions, entry points |
| `popup/` | The toolbar popup |
| `activity/` | The Activity page |
| `background/` | Service worker (server connection, sign-in tracking) and offscreen page |
| `content/` | The order reader, which runs only inside Waybill's hidden orders frame |
| `rules/` | The one network rule that lets the hidden frame load Amazon's orders page |
| `lib/` | Shared extension modules: Amazon access, storage, state store, server client |
| `icons/` | Extension and marketplace icons |
| `pages/` | Placeholder pages for services that don't exist yet |
| `dev/` | Development-only previews and diagnostics |
| `server/` | Node.js server, WebSocket implementation, storage (memory and PostgreSQL), migrations, tests |
| `Dockerfile`, `compose.yaml`, `.env.example` | Container setup |
| `tools/` | Static checks for the extension |
| `docs/` | Reference notes and verification records |

## Testing

```sh
node tools/check-extension.mjs        # manifest, permissions, assets, no remote code
node --test                           # server and storage tests (in-memory store)
WAYBILL_DB_PORT=5499 docker compose -p waybill-test --profile test run --rm tests   # the same against PostgreSQL
WAYBILL_DB_PORT=5499 docker compose -p waybill-test --profile test down -v          # clean up afterwards
```

The browser flows (popup, Activity, two profiles, live updates, removal)
have been verified end to end against generated Amazon-like pages in
separate test browsers. The record is in
[`docs/verification.md`](docs/verification.md).

## Scope of this release

- **Amazon** is fully supported on 11 marketplaces. The **AliExpress** card
  is part of the interface; connecting it is the next marketplace.
- **The Waybill account** is local in developer installs: "Log in" opens a
  local session without an account service. A hosted Waybill account comes
  with the companion web app.
- **Amazon has no buyer order API**, so Waybill reads Amazon's own website,
  as you would. When Amazon redesigns a page, the reader is updated
  accordingly.

## Next steps

- **Extensive testing:** automated unit and end-to-end tests for the
  extension in the repository, alongside the existing server tests.
- **Logging:** structured logs for the server and background worker, to
  diagnose issues in real use.
- Publication in the Chrome Web Store.

## License

[MIT](LICENSE)
