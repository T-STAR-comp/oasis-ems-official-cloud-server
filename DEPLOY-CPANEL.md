# cPanel / Spaceship deployment (simplified)

## Application settings

| Setting | Value |
|---------|--------|
| Application root | `cloud-server` folder (contains `package.json`) |
| Startup file | **`passenger-boot.cjs`** |
| Node version | 18+ |

Run `npm install` in the application root after each deploy.

## Required environment variables

```env
NODE_ENV=production
OASIS_TRUST_PROXY=1
JWT_SECRET=<long random>
OASIS_UID_SECRET=<long random>
```

For MySQL (recommended on cPanel):

```env
OASIS_USE_MYSQL=true
MYSQL_HOST=localhost
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=...
```

## Verify after restart

1. **https://your-domain/** — HTML status page (not a file download)
2. **https://your-domain/api/health** — JSON `{ "status": "ok", ... }`
3. **https://your-domain/api/debug/ping** — JSON `{ "ok": true }`

If you see **503** on API routes but `/` works, the app is still loading or database init failed — check logs for `startup.database_failed`.

If you see **404** on `/`, the request is not reaching Node — confirm startup file is `passenger-boot.cjs` and restart the app.

## Optional debug (disable after testing)

```env
OASIS_DEBUG_OPEN=1
```

Then open `/api/debug/diagnostics`.
