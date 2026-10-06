# Verification: milestone 1 (disconnected popup states)

## Static check

    node tools/check-extension.mjs

This checks:
- the manifest is valid MV3 and declares no permissions, service worker or content scripts;
- every referenced icon exists at its declared size;
- every local `href`/`src` resolves;
- there are no inline scripts or handlers, and no remote URLs.

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
| AliExpress chevron, Activity (`aria-disabled`) | No effect |
| Amazon "Log in" / Go to account | Opens `pages/marketplace-pending.html#amazon` / `pages/web-app-pending.html#account` |
| Log out | Returns to the signed-out view and hides the email pill |
| Unknown `?preview=` value | Signed-out view |
| `dev/preview.html` | Renders both states |

Not covered: the real toolbar-bubble rendering in Chrome, because headless
Chrome can't open action popups. This was checked by loading the page
directly at popup size.

## Reference comparison

The reference and our render are saved at matching sizes:
- `reference/signed-out-*.png`: 420×376
- `reference/signed-in-*.png`: 420×319
- `reference/signed-in-expanded-*.png`: 420×449

Calibration renders swap in the reference's strings (and, for the signed-in
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
| Collapsed: marketplace band and cards | 1.92 | Mostly the replaced marketplace logos |
| Collapsed: actions | 2.10 | Own-drawn glyphs; label within 1px |
| Expanded: card head | 2.85 | Logo tile |
| Expanded: details | 0.73 | |
| Collapsed header | 9.69 | Intentional: branding and a different fixture email |

In the signed-out view, every block's bounding box (dividers, tile, title,
subtitle, button, note and footer text) matches the reference to the pixel.

In the signed-in view, cards, switches, logo tiles, names, subtitles, the pill
and button edges match to the pixel; the chevron is within 1px.

## Manual check in a real browser

1. Open `chrome://extensions` (or `brave://extensions`), enable Developer mode, choose **Load unpacked**, and select the repo root.
2. Pin "Waybill" and click its toolbar icon. You should see the signed-out popup with no errors on the extension card.
3. Press Tab twice; focus should move to "Log in" and then "Sign up now". Press Enter on each; a new tab should show the "not available yet" page.
4. Open `chrome-extension://<id>/dev/preview.html`, or `chrome-extension://<id>/popup/popup.html?preview=signed-in`, to see the signed-in preview. `<id>` is on the extension card.
