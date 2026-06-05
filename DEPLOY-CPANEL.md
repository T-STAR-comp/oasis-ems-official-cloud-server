# cPanel / Spaceship deployment (simplified)

## Application settings

| Setting | Value |
|---------|--------|
| Application root | Folder containing `package.json` (e.g. `emsoasis.online` or `cloud-server`) — **not** inside `public_html` unless cPanel Node.js App owns that path |
| Startup file | **`passenger-boot.cjs`** |
| Node version | 18+ |

Run **Run NPM Install** (or `npm install`) in the application root after each deploy, then **Restart** the app.

## Files you must deploy

Upload the **entire** `cloud-server` folder, including:

- `passenger-boot.cjs`, `server.js`, `createApp.mjs`
- `routes/`, `middleware/`, `db/`, `utils/`, **`shared/`** (includes `subscriptions.js`, `connectivityProbe.js`, `cloudServerDiscovery.js`)
- **`.htaccess`** (Passenger fallback rewrites — required for `/api/*` routes)
- `package.json` / `package-lock.json`

Do **not** rely on a parent monorepo `shared/` folder on the server; the cloud-server copy is self-contained.

## Required environment variables

```env
NODE_ENV=production
OASIS_TRUST_PROXY=1
OASIS_PUBLIC_CLOUD_URL=https://your-cpanel-domain.example.com
JWT_SECRET=<long random>
OASIS_UID_SECRET=<long random>
```

For MySQL (recommended on cPanel):

```env
OASIS_USE_MYSQL=true
MYSQL_HOST=localhost
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=your_cpanel_database_name
```

cPanel grants **one** MySQL database per app user. When `MYSQL_DATABASE` is set, the cloud server stores each migrated school in **prefixed tables** inside that database (for example `ems_oasis_abc123_users`). You do **not** need `CREATE DATABASE` privileges.

For a VPS with full MySQL admin rights and separate databases per school:

```env
OASIS_MYSQL_TENANT_MODE=database
MYSQL_DATABASE_PREFIX=oasis_ems
```

## Verify after restart

1. **https://your-domain/** — HTML status page (not a file download)
2. **https://your-domain/api/health** — JSON `{ "status": "ok", ... }`
3. **https://your-domain/api/debug/ping** — JSON `{ "ok": true }`

Quick check from terminal:

```bash
curl -s https://your-domain/api/health
curl -s https://your-domain/api/debug/ping
```

## Troubleshooting

### Only `/` works; `/api/health` downloads `passenger-boot.cjs` source

LiteSpeed/Apache is serving static files instead of forwarding paths to Passenger. The **Passenger fallback** block in `.htaccess` is missing or was removed.

1. In cPanel → **Setup Node.js App** → **Restart** (regenerates `.htaccess` if you delete the old one first).
2. Ensure the repo **`.htaccess`** is present in the application root and contains the `CLOUDLINUX PASSENGER FALLBACK` rewrite block.
3. Do **not** replace the whole file if cPanel already added `PassengerAppRoot` / `PassengerStartupFile` — merge: keep cPanel’s Passenger block **and** the fallback block from this repo.

Symptom: `content-type: application/octet-stream` and response body starts with `/** cPanel / Phusion Passenger startup file`.

### Boot error: `Cannot find module '.../shared/connectivityProbe.js'`

The deploy is missing `cloud-server/shared/` or `routes/debug.js` still imports `../../shared/...` from the monorepo. Redeploy with the bundled `shared/` folder and restart.

Check: `curl -s -H "Accept: application/json" https://your-domain/` should show `"boot":{"ready":true,...}` after a successful start.

### 503 on API routes but `/` works

The app is still loading or database init failed — check logs for `startup.database_failed`.

### 404 on `/`

The request is not reaching Node — confirm startup file is `passenger-boot.cjs` and restart the app.

## Optional debug (disable after testing)

```env
OASIS_DEBUG_OPEN=1
```

Then open `/api/debug/diagnostics`.
