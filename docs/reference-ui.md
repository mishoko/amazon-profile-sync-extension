# Reference UI: disconnected states

Black-box reference: **Trackerbot** extension **v0.2.12.27** (Web Store listing
updated 2026-10-01), installed in Brave (Default profile), macOS, 1× display.
Observed 2026-10-06 through ordinary use: toolbar clicks, screenshots, and the
browser's own extension details page. No extension source or manifest was read.

## Surfaces

| Surface | Observed | Notes |
| --- | --- | --- |
| Toolbar action popup | Yes | Opens on toolbar-icon click. Brave bubble 434×390; page document **420×376** including its 1px border. |
| Same `popup/popup.html` in a standalone 420×640 popup window | Yes, once | Already open before inspection; showed a stale signed-in view (see State B). How it is opened is unknown. |
| "Trackerbot – Working Window" (`tb-splash.html`) | Yes | Full browser window: "Trackerbot is running background processes here to keep your orders and tracking information in sync. Please do not close or use this window." Present while signed out. **Out of scope.** |

## State A: signed out (observed, reproduced)

Evidence: `reference/signed-out-reference.png` (page crop, 420×376).

Top to bottom, in page pixels:

- 1px border `#e5e9f0` around the page.
- Header 48px, white, 1px bottom divider. Logo mark 28px at x=16 plus a logotype.
- Body, white, centred column, 26px side inset:
  - Lock tile: 56×56 at y=90, `#f4f8ff` fill, `#e1ecff` 1px border, 16px radius, `#0065fc` lock glyph (~24×26 ink).
  - Title: "Log in to Trackerbot", system font 700, 18.5px, `#1c1c28`. Ink top at y=165.
  - Subtitle: "Connect the extension to your account.", 13.5px, `#7a7e94`. Ink top at y=195.
  - Primary button: 366×44 at y=232, `#0065fc`, 10px radius. Label "Log in" (600, 14px, white) plus an external-link glyph.
  - Note: "Opens app.trackerbot.me in a new tab", 12px, `#a8adc4`. Ink top at y=289.
- Footer 44px, `#f7f8fb`, 1px top divider. "Don't have an account?" (13px, `#4a4d63`) followed by "Sign up now" (600, `#0065fc`).

Fonts: the subtitle and note re-render pixel-identically with `system-ui` (SF on
macOS), so the reference uses the system font stack.

Interactions:

| Control | Behaviour | Evidence |
| --- | --- | --- |
| Log in | Opens `app.trackerbot.me` (the web app login page) in a new tab; popup closes. | Clicked |
| Sign up now | Not clicked. Destination unknown (likely web app sign-up). | — |
| Logo | Unknown whether interactive. | — |

## State B: signed in, zero marketplace accounts (partial, not implemented)

Seen only in the stale standalone window, not yet in the live toolbar popup.
Contents:

- **Header:** an account-email pill.
- **Amazon card:** toggle on, subtitle "Tracking checker", expanded. Marketplace select ".com"; Account row with a red-outline "Log in" button; Connection row with a red "Inactive" pill.
- **AliExpress card:** toggle off, collapsed.
- **Actions:** primary "Go to Trackerbot account" button with an external-link glyph, then "Activity" and "Log out" buttons.

Height, interactions and live behaviour are unknown. **Blocked:** needs a live
capture after logging in.

## Session sharing between extension and web app (inferred, unverified)

Observed:

- Permissions shown by the browser: read browsing history, display notifications, manage apps/extensions/themes.
- Host list includes the eBay, Amazon and AliExpress/Alibaba domains, `app.trackerbot.me`, a Datadog log-intake host, and a Heroku "jobs queue" host. Automatic site access was **off** in this browser; on `app.trackerbot.me` the toolbar shows "Wants access to this site".
- The user reports that logging in or out of either surface propagates to the other.
- A popup window opened earlier kept showing the signed-in view after the web app showed its login page. State is read when the popup opens, not pushed live.

How the session reaches the extension (web-app-to-extension messaging,
cookie/API calls, or something else) is **not determined**. Checking it would
mean watching the extension's own network traffic during login, which hasn't
been done. This project does not need their mechanism; ours will be designed
with the companion app.

## Intentional differences (implementation)

- **Branding:** name "Waybill", our own route-"W" mark (`icons/icon.svg`), and a text wordmark instead of the logotype.
- **Note copy:** "Opens the Waybill web app in a new tab".
- **Log in / Sign up now:** open the local `pages/web-app-pending.html`, which states that no web app exists yet and nothing was sent. No credentials are collected.
- **Glyphs:** the lock and external-link glyphs are our own drawings, matched in size only.
- **Not reproduced:** no permissions, service worker, working window, or telemetry.
- **Hover and active states:** not added, because none were observed. A keyboard focus ring was added for accessibility.

## Unknowns

Hover, active and focus visuals; popup loading or error states; the
"Sign up now" destination; the live State B popup and all of its interactions.
