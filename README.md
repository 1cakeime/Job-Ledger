# Job Ledger

Jobsite organization and profit tracking for contractors. An installable web
app (PWA): add it to a phone's home screen and it works offline.

- **Jobs**: client, address, contract price, change orders, your estimate by
  category, notes, status (bid / active / done).
- **Purchases & expenses**: per job, by category, with a receipt photo.
- **Photos**: take or upload job photos, with captions.
- **Schedule**: weekly crew calendar; shifts are scheduled, worked or missed.
  Copy last week, mark past shifts worked.
- **Crew & Pay**: hourly rates, labor burden, overtime (1.5x over 40h/week),
  payroll by person and by job.
- **Profit**: real profit and margin per finished job, projected profit on open
  jobs, and estimating accuracy (where your bids run high or low).

## Data

Everything is stored on the device (IndexedDB), never on a server. Settings ->
Export backup saves a JSON file (photos included) that can be restored on
another device.

## Files

- `index.html` – the whole app (HTML, CSS, JS, no build step)
- `manifest.webmanifest`, `icons/` – install metadata and icons
- `sw.js` – service worker for offline use; bump `VERSION` on each release
