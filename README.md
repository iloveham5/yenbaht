# YenBaht

Income & expense tracker for iPhone (installable web app) with two wallets: 🇯🇵 JPY and 🇹🇭 THB.

- **Quick add:** open → type amount → tap a category. Wallet is picked from the phone's time zone.
- **Auto-record:** an iPhone Shortcuts "Transaction" automation sends every Suica / Apple Pay tap to your own Google Sheet; the app pulls them in and learns each shop's category.
- **PayPay:** import the monthly CSV from the PayPay app (duplicates skipped).
- Transfers between wallets, balance adjustments, history, monthly stats, CSV/JSON backup, works offline.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.css`, `app.js` | The app (no build step, no dependencies) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `guide.html` | Setup guide shown inside the app |
| `google-apps-script.txt` | Backend to paste into a Google Sheet's Apps Script |

## Hosting

Any static HTTPS host works (GitHub Pages, Netlify, Cloudflare Pages). After changing files, bump `CACHE` in `sw.js` so phones pick up the update.

## Run locally

```bash
py -m http.server 8765
```

Then open http://localhost:8765.
