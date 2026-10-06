# Verification: milestone 1 (signed-out popup)

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

Not covered: the real toolbar-bubble rendering in Chrome, because headless
Chrome can't open action popups. This was checked by loading the page
directly at popup size.

## Reference comparison

`reference/signed-out-reference.png` and `reference/signed-out-ours.png` are
both 420×376. A calibration render of our CSS with the reference's strings
gave the following mean per-pixel difference (0–255):

| Region | Mean diff | Notes |
| --- | --- | --- |
| Subtitle | 0.19 | Pixel-identical within anti-aliasing |
| Note | 0.10 | Pixel-identical within anti-aliasing |
| Footer | 0.39 | |
| Button | 0.55 | Differs only in the own-drawn external-link glyph |
| Tile | 0.75 | Differs only in the own-drawn lock glyph |
| Title | 2.50 | Sub-pixel weight and rendering difference; same ink box (175×19) |
| Header | 8.72 | Intentional: replaced branding |

All block bounding boxes (dividers, tile, title, subtitle, button, note and
footer text) match the reference to the pixel.

## Manual check in a real browser

1. Open `chrome://extensions` (or `brave://extensions`), enable Developer mode, choose **Load unpacked**, and select the repo root.
2. Pin "Waybill" and click its toolbar icon. You should see the signed-out popup with no errors on the extension card.
3. Press Tab twice; focus should move to "Log in" and then "Sign up now". Press Enter on each; a new tab should show the "not available yet" page.
