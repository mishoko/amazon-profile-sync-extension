# Verification: milestone 1 (disconnected popup states)

## Static check

    node tools/check-extension.mjs

This checks:
- the manifest is valid MV3 and declares no permissions, service worker or content scripts;
- every referenced icon exists at its declared size;
- every local `href`/`src` resolves;
- there are no inline scripts or handlers, and no remote URLs other than the
  Amazon orders link target (a navigation the user opens, never fetched).

## Browser check (run 2026-10-06)

Chrome for Testing 1243, headless, using `--load-extension` with a fresh
profile. Scratch Playwright tooling was used; it is not a project dependency.

| Check | Result |
| --- | --- |
| Extension loads; `popup/popup.html` served | 200 |
| Console errors / page errors / failed requests | none |
| Network requests outside `chrome-extension://` | none |
| Popup document size | 420×376 (reference 420×376) |
| Tab order | "Log in", then "Sign up now"; both show a 2px focus ring |
| Enter on "Log in" / "Sign up now" | Opens `pages/web-app-pending.html#log-in` / `#sign-up` in a new tab |

Signed-in preview (`popup.html?preview=signed-in`), same setup:

| Check | Result |
| --- | --- |
| Height, collapsed / Amazon expanded | 319 / 449 (reference 319 / 449) |
| Console errors / non-extension requests | none / none |
| Tab order | Amazon switch, Amazon chevron, AliExpress switch, AliExpress chevron, Go to account, Activity, Log out |
| Space on switch / Enter on Amazon chevron | `aria-checked` becomes true / details shown, `aria-expanded` becomes true |
| Amazon chevron, click or Enter while switch off | No effect; `aria-disabled="true"` |
| Switch Amazon off while expanded | Details hidden; chevron disabled again |
| AliExpress switched on, then chevron clicked | No effect; chevron stays disabled |
| Activity (`aria-disabled`) | No effect |
| Amazon "Log in", each of the 11 marketplaces | `href` is `https://www.amazon<domain>/your-orders/orders?orderFilter=last30` |
| Amazon "Log in" clicked with .it | New tab at the .it URL, no `Referer`. Outbound requests were stubbed, so Amazon was never contacted. |
| Go to account | Opens `pages/web-app-pending.html#account` |
| Log out | Returns to the signed-out view and hides the email pill |
| Unknown `?preview=` value | Signed-out view |
| `dev/preview.html` | Renders both states |

Simulated sign-in (2026-10-07, same setup, no `?preview=`):

| Check | Result |
| --- | --- |
| Initial view / note | Signed out / "Development build: simulated sign-in, no account is used" |
| Enter on "Log in" | `aria-busy="true"`, label "Logging in…", spinner shown, no new tab |
| Second click while busy | Ignored |
| Time to signed-in view | 2512 ms; email pill `preview@example.com` |
| Reload after sign-in / after Log out | Signed in / signed out |
| `dev/preview.html` | Signed-out and signed-in frames regardless of stored state |
| Console errors / non-extension requests | none / none |

Not covered: the real toolbar-bubble rendering in Chrome, because headless
Chrome can't open action popups. This was checked by loading the page
directly at popup size.

## Reference comparison

The reference and our render are saved at matching sizes:
- `reference/signed-out-*.png`: 420×376
- `reference/signed-in-*.png`: 420×319
- `reference/signed-in-expanded-*.png`: 420×449

The signed-in rows above, except actions, compare the committed renders as they
are (y ranges in page pixels). Calibration renders swap in the reference's strings (and, for the signed-in
view, its email) in a scratch copy that is never committed.

Mean per-pixel difference (0–255), signed out:

| Region | Mean diff | Notes |
| --- | --- | --- |
| Subtitle | 0.19 | Pixel-identical within anti-aliasing |
| Note | 0.10 | Pixel-identical within anti-aliasing |
| Footer | 0.39 | |
| Button | 0.55 | Differs only in the own-drawn external-link glyph |
| Tile | 0.75 | Differs only in the own-drawn lock glyph |
| Title | 2.50 | Sub-pixel weight and rendering difference; same ink box (175×19) |
| Header | 7.83 | Intentional: replaced branding |

Signed in:

| Region | Mean diff | Notes |
| --- | --- | --- |
| Collapsed: marketplace band and cards | 0.78 | Was 1.92 with letter tiles; the rest is the Amazon tile |
| Collapsed: actions | 2.10 | Own-drawn glyphs; label within 1px (calibration render with the reference's label) |
| Expanded: card head (y 50–120) | 0.93 | Was 2.17 with letter tiles |
| Expanded: details | 0.74 | |
| Collapsed header | 9.69 | Intentional: branding and a different fixture email |

In the signed-out view, every block's bounding box (dividers, tile, title,
subtitle, button, note and footer text) matches the reference to the pixel.

In the signed-in view, cards, switches, logo tiles, names, subtitles, the pill
and button edges match to the pixel; the chevron is within 1px.

## Manual check in a real browser

1. Open `chrome://extensions` (or `brave://extensions`), enable Developer mode, choose **Load unpacked**, and select the repo root.
2. Pin "Waybill" and click its toolbar icon. You should see the signed-out popup with no errors on the extension card.
3. Press Tab twice; focus should move to "Log in" and then "Sign up now". Enter on "Sign up now" opens the "not available yet" page in a new tab.
4. Click "Log in": "Logging in…" for about 2.5s, then the signed-in view. Close and reopen the popup: still signed in until "Log out".
5. Switch Amazon on, open its details, pick a marketplace and click "Log in": a new tab opens on that Amazon site (its sign-in page if you are not signed in recently).
6. Open `chrome-extension://<id>/dev/preview.html`, or `chrome-extension://<id>/popup/popup.html?preview=signed-in`, to see the signed-in preview. `<id>` is on the extension card.

## Accounts across browser profiles (2026-10-07)

Run the local server, then reload Waybill in each profile:

    docker compose up -d --build   # in a container, published on 127.0.0.1:4417 only
    node server/server.mjs         # or directly with Node 22
    node --test                    # server tests (built-in runner)

The container runs as a non-root user with a read-only filesystem, no
capabilities, and no npm dependencies. Checked: the server answers on
127.0.0.1, rejects other origins and Host headers, and is not reachable on
the machine's LAN address. The two-profile checks below also pass against
the container (Compose project on port 4499), including stop and restart.

Each profile's background worker connects, registers its Amazon account
summaries (never orders), and reads orders in that profile when asked.

Executed in Chrome for Testing 1243 with two separate profiles, the real
server, synthetic Amazon pages per profile, and no outside network:

| Check | Result |
| --- | --- |
| Profile A's Activity list | A's .com and .co.uk ("This browser profile") and B's .com ("Another browser profile") |
| Select B's account in A | Orders read by B (Amazon requests seen only in B), shown as "Read live from Amazon in another browser profile" |
| Order cards filled in late by page script, like Amazon's decryption | Read correctly |
| Server stopped, Activity reloaded | "Accounts in this browser profile" with the fallback notice; A's accounts still load |
| Extension errors with the server down (developer mode on) | None |

Live updates (same setup, A's Activity left open, no reload):

| Check | Result |
| --- | --- |
| B opens Amazon's sign-out page | B's account disappears from A's list |
| B finishes a sign-in (sign-in page, then an Amazon page) | B's account reappears |
| Server stopped / restarted | A falls back to "this browser profile", then returns to all profiles by itself |
| No server: an account saved or removed in this profile | List follows |
| "Fetching live from Amazon…" while a period reloads | Shown; previous orders stay, dimmed; no stray "false" |

Tests run on a copy of the extension pointed at port 4499, never at 4417,
so they can't reach a server or browser profile in real use. In that copy
the offscreen page's Amazon requests are answered by a stand-in, because
Playwright can't intercept requests from offscreen documents.

Not yet tested on real Amazon across two real profiles.

To watch a live read, open `activity/activity.html?showOrdersWindow` (development
builds, this-profile mode): the Amazon window stays open for DevTools.
