# Oasis EMS Cloud Server

This folder is a cloud-ready duplicate of the local Oasis EMS server.

## Purpose
- Run one online SQLite-backed server per school.
- Desktop clients in `online` mode can point to this server URL.
- Supports migration bootstrap via:
  - `POST /api/system/import-bootstrap`

## Quick Start
1. `cd Cloud-server`
2. `npm install`
3. Configure environment variables (`PORT`, `JWT_SECRET`, etc.)
4. `npm start`

## Migration Flow
1. Desktop app (admin) stays in offline mode.
2. In Settings, set cloud URL and run **Migrate Local Data To Cloud**.
3. App exports local data and sends it to `/api/system/import-bootstrap`.
4. App switches to online mode and uses cloud API URL.
