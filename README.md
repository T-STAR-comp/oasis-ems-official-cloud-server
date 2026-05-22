# Oasis EMS Cloud Server

This folder is a cloud-ready duplicate of the local Oasis EMS server.

## Purpose
- Run one online server per school, backed by SQLite by default or MySQL when enabled.
- Desktop clients in `online` mode can point to this server URL.
- Supports migration bootstrap via:
  - `POST /api/system/import-bootstrap`

## Quick Start
1. `cd Cloud-server`
2. `npm install`
3. Configure environment variables (`PORT`, `JWT_SECRET`, etc.)
4. `npm start`

## Database Mode
SQLite remains the default:

```env
OASIS_USE_MYSQL=false
```

To use MySQL instead, set:

```env
OASIS_USE_MYSQL=true
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=oasis_ems
```

If `MYSQL_DATABASE` is omitted, the cloud server creates one database per school using `MYSQL_DATABASE_PREFIX` plus the School ID. The full MySQL schema is in `db/mysql-schema.sql`.

## Migration Flow
1. Desktop app (admin) stays in offline mode.
2. In Settings, set cloud URL and run **Migrate Local Data To Cloud**.
3. App exports local data and sends it to `/api/system/import-bootstrap`.
4. App switches to online mode and uses cloud API URL.
