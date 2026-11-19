# Blue Board

Job, crew and profit tracking for contractors. One app runs as the website
([getblueboard.com](https://getblueboard.com)) and as the iPhone app.

- **Jobs**: client, address, contract price, change orders, estimate by
  category, notes, status (bid / active / done), photos with before/after and markup.
- **Estimates & invoices**: send a link the customer can view, sign and pay by card
  (Stripe Connect, paid straight to the contractor).
- **Customer portal**: one link per job where the customer sees dates, makes picks
  and opens their estimates, invoices and photos.
- **Schedule**: weekly crew calendar with a "Needs your attention" list for the owner.
- **Crew**: clock in/out, breaks, daily reports, time-off and "fix my time" requests,
  push notifications and "Still on the clock?" reminders. Crew phones save work
  offline and send it when there's signal.
- **Crew & Pay**: hourly rates, labor burden, overtime, payroll by person and job,
  payroll file downloads (Gusto, ADP, Paychex, QuickBooks).
- **Profit**: real profit and margin per finished job, projected profit on open jobs,
  and how accurate your bids are.

## Data

Accounts, companies and job data are stored in Supabase and sync between the
owner's and crew's devices. The app keeps a local copy so it still works without
signal. Settings -> Export backup saves a JSON file of the company's data.

## Plans

Solo, Crew and Company plans with a 14-day free trial, bought on the website.

## Files

- `index.html` – the whole app (HTML, CSS, JS, no build step)
- `welcome.html` – website intro page; `privacy.html`, `support.html` – public pages
- `doc.html`, `portal.html` – customer pages for estimates/invoices and job portals
- `supabase/` – database schema and Edge Functions (push, payments, billing, crew sign-up)
- `ios/` – iPhone app (Capacitor)
- `sw.js` – service worker for offline use; bump `VERSION` when a cached file changes

See `CLAUDE.md` for how changes are shipped.
