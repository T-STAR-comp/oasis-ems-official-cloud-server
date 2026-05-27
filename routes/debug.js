import express from 'express';
import { getDatabaseDebugInfo } from '../db/database.js';
import { getRecentLogs, logInfo } from '../utils/logger.js';

const router = express.Router();

function isAllowed(req) {
  const token = String(process.env.OASIS_DEBUG_TOKEN || '').trim();
  if (!token) {
    return String(process.env.OASIS_DEBUG_OPEN || '').trim() === '1';
  }
  const provided = String(req.query?.token || req.headers['x-debug-token'] || '').trim();
  return provided === token;
}

router.get('/logs', (req, res) => {
  if (!isAllowed(req)) {
    return res.status(403).json({ error: 'Invalid debug token.' });
  }

  const limit = Number(req.query?.limit || 300);
  const schoolId = String(req.query?.school_id || '').trim();
  const payload = {
    warning: 'Temporary debug endpoint. Remove or protect this route after diagnosis.',
    generated_at: new Date().toISOString(),
    process: {
      pid: process.pid,
      cwd: process.cwd(),
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
      env: {
        NODE_ENV: process.env.NODE_ENV || null,
        PASSENGER_APP_ENV: process.env.PASSENGER_APP_ENV || null,
        PASSENGER_BASE_URI: process.env.PASSENGER_BASE_URI || null,
        OASIS_USE_MYSQL: process.env.OASIS_USE_MYSQL || null,
        MYSQL_HOST_SET: Boolean(process.env.MYSQL_HOST),
        MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
        MYSQL_DATABASE_PREFIX: process.env.MYSQL_DATABASE_PREFIX || null,
        OASIS_DATA_DIR: process.env.OASIS_DATA_DIR || null,
        OASIS_PUBLIC_URL_SERVER: process.env.OASIS_PUBLIC_URL_SERVER || null,
        OASIS_PLANS_SERVER_URL: process.env.OASIS_PLANS_SERVER_URL || null,
        OASIS_LICENSE_SERVER_URL: process.env.OASIS_LICENSE_SERVER_URL || null,
        PAYCHANGU_SECRET_KEY_SET: Boolean(process.env.PAYCHANGU_SECRET_KEY || process.env.PAYCHANGU_API_KEY),
        SMTP_HOST_SET: Boolean(process.env.SMTP_HOST),
        OASIS_UID_SECRET_SET: Boolean(process.env.OASIS_UID_SECRET),
      },
    },
    database: getDatabaseDebugInfo(schoolId || null),
    logs: getRecentLogs({
      limit,
      level: req.query?.level,
      event: req.query?.event,
    }),
  };

  logInfo('debug.logs_served', {
    request_id: req.requestId || null,
    limit,
    school_id: schoolId || null,
    log_count: payload.logs.length,
  });

  return res.json(payload);
});

export default router;
