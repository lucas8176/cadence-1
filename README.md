# Cadence Inventory v2.1 (hostable web app)

No npm packages. Needs **Node 22.13 or newer** (uses the built-in SQLite). A `.node-version` file (22) is included for Render; Docker uses node:22.

## Run it
    node server.js            # http://localhost:3000
The first start prints the admin login (or set ADMIN_USER / ADMIN_PASSWORD).

## Where data lives (DATA_DIR, default ./data)
- `cadence.sqlite`: one database, separate tables:
  - `users`, `sessions` (hashed passwords, approval flag, role)
  - `items` (one row per piece of equipment, indexed by category, location, maintenance-due)
  - `events` (history: check-in/out, moves, condition, maintenance, one row each, linked to its item)
  - `cats`, `locs`, `meta`
- `photos/`: maintenance photos (deleted when the item is serviced or deleted)
Back up the whole DATA_DIR, or use Users → "Download full backup (JSON)" in the app.

## Upgrading from v1
Keep your old DATA_DIR. On first start the server imports `db.json` (users, items, history, categories, locations) into SQLite and renames it `db.json.migrated`.

## Syncing
The browser sends only what changed (items edited, new history events, deletions), so two people editing different items never overwrite each other. Screens refresh every 15 s.

## Environment variables
PORT, DATA_DIR (point at a persistent disk), ADMIN_USER, ADMIN_PASSWORD (first run only), GOOGLE_CLIENT_ID (optional), COOKIE_SECURE=1.

## Hosting
Render/Railway: start command `node server.js`, attach a persistent disk/volume, set DATA_DIR to its mount path. On Render, if the build uses an old Node, add env var NODE_VERSION=22. Docker: `docker build -t cadence . && docker run -d -p 3000:3000 -v cadence-data:/data cadence`.

## What's in the app (v2.1)
- Dark app shell: collapsible sidebar, top bar with breadcrumb, notification count and command palette (Cmd/Ctrl+K), bottom tab bar on phones.
- Dashboard: needs-attention list (overdue returns, maintenance, low stock, pending accounts), who has what, recent activity.
- Inventory table with sorting, filters, multi-select, bulk move and bulk QR label sheets.
- Check-out with optional return-by date; overdue items are flagged.
- Scan modes: open item, check in (continuous), move to location (continuous). Location tags: scan one to set the target location.
- Locations page with printable location tags; Activity page (full audit trail); Reports; Settings (categories, CSV import/export, backup).
- CSV import for existing inventory (Settings -> CSV template).
