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

## State B: signed in, zero marketplace accounts (observed, reproduced)

Evidence, with the account email painted out:

- `reference/signed-in-reference.png`: the live toolbar popup right after logging in, 420×319. This is the default state.
- `reference/signed-in-expanded-reference.png`: a 420×449 page from the stale standalone window, with Amazon toggled on and expanded. It shares the same header, card and action geometry as the live capture, to the pixel.

Layout, in page pixels:

- **Header:** same as State A, plus an email pill at the right. 27px tall, 15px from the right edge, `#f4f8ff` fill, `#e5e9f0` border, 12.5px/500 text with 12px padding.
- **Marketplace band:** `#f7f8fb`, 15px padding, 1px bottom divider. Two cards 388px wide, 15px apart. Each card is white with a `#e5e9f0` border and 14px radius.
  - Collapsed card head, 53px: 34×20 switch (off `#cbd2e0`, on `#0065fc`), 32px marketplace logo, name (15px/700), "Tracking checker" (12px, `#7a7e94`), and a chevron (`#a8adc4`) that points up when expanded.
  - Expanded Amazon details, below a `#eef1f6` divider. Labels are 13px `#4a4d63`.
    - Marketplace: a 95×22 select showing ".com".
    - Account: a 27px "Log in" button, `#e5484d` text, 7px radius.
    - Connection: an "Inactive" pill, 20px tall, `#fdecec` fill, `#e5484d` text.
- **Actions:** white, 15px padding.
  - "Go to Trackerbot account": 38px tall, 13.5px/600, with an external-link glyph.
  - "Activity" and "Log out": two 34px outlined buttons, 13px/500, 10px gap.

Interactions:

| Control | Behaviour | Evidence |
| --- | --- | --- |
| Toggle switches | Both states seen: off (live), Amazon on (stale window). Beyond enabling the chevron, what switching on does is unknown. | Visual only |
| Chevrons | Can only be opened while the marketplace's switch is on. Expanded Amazon seen, with the chevron pointing up. AliExpress expanded was never seen. | User report (2026-10-07); visual |
| Amazon "Log in" | Opens a new tab on the selected marketplace's Amazon sign-in. For .it: `www.amazon.it/ap/signin?…return_to=…amazon.it/your-orders/orders?orderFilter=last30…assoc_handle=amzn_retail_yourorders_it…language=en_GB…`; for .com the same with `_us` and `en_US`. `max_auth_age=0` makes Amazon ask for the password even when already signed in. | User report (2026-10-07) |
| Go to Trackerbot account, Activity, Log out | Not exercised. The user reports that logout propagates to the web app. | — |

Clicks sent by automation to the live popup did not register, so none of these
controls were exercised by me.

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

## Amazon sign-in URL (verified 2026-10-07)

An unauthenticated request to `https://www.amazon<domain>/your-orders/orders?orderFilter=last30`
gets a 302 from Amazon to exactly the sign-in URLs reported above: byte for
byte for .com, and for .it with `Accept-Language: en-GB`. Amazon chooses
`assoc_handle` and `language` itself; it gave the same shape for .ca, .com.au,
.de, .ie, .ae and .sa. .co.uk, .es and .fr answered 503 (bot check) to plain
requests and were not confirmed. Whether the reference opens the orders page
or the sign-in URL directly can't be told from the tab it ends on.

## Intentional differences (implementation)

- **Branding:** name "Waybill", our own route-"W" mark (`icons/icon.svg`), and a text wordmark instead of the logotype.
- **Marketplace logos:** official marks, bundled locally in `icons/marketplaces/`.
  - AliExpress: AliExpress's own app icon, from aliexpress.com's `og:image`, downscaled to 64px.
  - Amazon: Amazon's "a" and smile glyph (Wikimedia Commons, credited to Amazon.com, Inc.) placed on a dark tile sized to the reference. The reference's tile is a different rendering of the same mark (heavier "a"); the 32px tile differs by a mean of 16.8/255.
- **Copy:** "Opens the Waybill web app in a new tab"; "Go to Waybill account".
- **No real service behind any control.** Each control has an explicit local outcome:
  - Sign up now / Go to account open the local `pages/web-app-pending.html`.
  - Amazon "Log in" opens Amazon itself (see above), in a new tab without a referrer. Nothing comes back to the extension, so Connection stays "Inactive".
  - Nothing is sent to any Waybill service, and no Waybill account is created.
- **Sign-in is simulated, in development builds only.** "Log in" shows "Logging in…" with a spinner for 2.5s, then State B with the fixture `preview@example.com` from `dev/preview-sessions.js`. It persists in the popup's `localStorage` until "Log out". The note under the button reads "Development build: simulated sign-in, no account is used". Store builds keep the reference behaviour (open the web app in a new tab). `popup.html?preview=<name>` still forces a fixture. The loading state is ours: the reference's was never seen.
- **Unobserved behaviour is not invented:**
  - Switches change local UI state only. Switching Amazon off also collapses its details (our choice; not observed).
  - The AliExpress chevron stays `aria-disabled` even when switched on, and "Activity" is `aria-disabled`.
  - The marketplace select options are taken from the reference's Amazon host list, not from observation.
- **Glyphs:** the lock, external-link, chevron, activity and log-out glyphs are our own drawings, matched in size only.
- **Not reproduced:** no permissions, service worker, working window, or telemetry.
- **Hover and active states:** not added, because none were observed. Keyboard focus rings were added for accessibility.

## Unknowns

- Hover, active and focus visuals.
- Popup loading and error states.
- The "Sign up now" destination.
- What the switches, "Activity", "Go to account" and "Log out" actually do in the reference.
- AliExpress expanded content.
- Whether toggling a marketplace on auto-expands it.
