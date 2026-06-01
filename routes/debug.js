import express from 'express';
import { getDatabaseDebugInfo } from '../db/database.js';
import { getRecentLogs, logInfo } from '../utils/logger.js';
import { probeCloudHealth, probeHttpEndpoint } from '../../shared/connectivityProbe.js';
import {
  fetchCloudServerUrlFromLicenseServer,
  getCloudServerUrlOverride,
  getDiscoveryServerUrl,
  readCachedCloudServerUrl,
} from '../../shared/cloudServerDiscovery.js';

const router = express.Router();
const PAYCHANGU_BASE_URL = String(process.env.PAYCHANGU_BASE_URL || 'https://api.paychangu.com').trim().replace(/\/+$/, '');

function isAllowed(req) {
  const token = String(process.env.OASIS_DEBUG_TOKEN || '').trim();
  if (!token) {
    return String(process.env.OASIS_DEBUG_OPEN || '').trim() === '1';
  }
  const provided = String(req.query?.token || req.headers['x-debug-token'] || '').trim();
  return provided === token;
}

function requireDebugAccess(req, res, next) {
  if (!isAllowed(req)) {
    return res.status(403).json({ error: 'Invalid debug token. Set OASIS_DEBUG_TOKEN or OASIS_DEBUG_OPEN=1.' });
  }
  return next();
}

router.get('/ping', (req, res) => {
  return res.json({
    ok: true,
    service: 'oasis-ems-cloud',
    timestamp: new Date().toISOString(),
    request_id: req.requestId || null,
  });
});

router.get('/diagnostics', requireDebugAccess, async (req, res) => {
  const schoolId = String(req.query?.school_id || '').trim();
  const selfBaseUrl = String(req.query?.self_base_url || process.env.OASIS_PUBLIC_CLOUD_URL || '').trim().replace(/\/+$/, '');
  const payload = {
    warning: 'Protect debug routes in production. Disable OASIS_DEBUG_OPEN after testing.',
    generated_at: new Date().toISOString(),
    process: {
      pid: process.pid,
      cwd: process.cwd(),
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
      passenger: Boolean(process.env.PASSENGER_APP_ENV || process.env.PASSENGER_BASE_URI),
    },
    config: {
      NODE_ENV: process.env.NODE_ENV || null,
      OASIS_USE_MYSQL: process.env.OASIS_USE_MYSQL || null,
      MYSQL_HOST_SET: Boolean(process.env.MYSQL_HOST),
      MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
      OASIS_DATA_DIR: process.env.OASIS_DATA_DIR || null,
      OASIS_UPLOADS_DIR: process.env.OASIS_UPLOADS_DIR || null,
      OASIS_CLOUD_SERVER_URL_OVERRIDE: Boolean(getCloudServerUrlOverride()),
      OASIS_LICENSE_SERVER_URL: process.env.OASIS_LICENSE_SERVER_URL || null,
      OASIS_PUBLIC_URL_SERVER: process.env.OASIS_PUBLIC_URL_SERVER || null,
      PAYCHANGU_SECRET_KEY_SET: Boolean(process.env.PAYCHANGU_SECRET_KEY || process.env.PAYCHANGU_API_KEY),
      PAYCHANGU_KEY_MODE: String(process.env.PAYCHANGU_SECRET_KEY || '').startsWith('sec-test-') ? 'sandbox' : 'live_or_unknown',
      SMTP_HOST_SET: Boolean(process.env.SMTP_HOST),
      OASIS_UID_SECRET_SET: Boolean(process.env.OASIS_UID_SECRET),
      JWT_SECRET_SET: Boolean(process.env.JWT_SECRET),
    },
    discovery: {
      discovery_server_url: getDiscoveryServerUrl(),
      cached_cloud_url: readCachedCloudServerUrl() || null,
      env_cloud_override: getCloudServerUrlOverride() || null,
    },
    database: getDatabaseDebugInfo(schoolId || null),
    self_health: selfBaseUrl
      ? await probeCloudHealth(selfBaseUrl, { timeoutMs: 10000 })
      : { skipped: true, hint: 'Pass ?self_base_url=https://your-domain.com to test public routing.' },
  };

  logInfo('debug.diagnostics_served', {
    request_id: req.requestId || null,
    school_id: schoolId || null,
  });

  return res.json(payload);
});

router.get('/test-license-discovery', requireDebugAccess, async (req, res) => {
  try {
    const resolved = await fetchCloudServerUrlFromLicenseServer({
      timeoutMs: Number(req.query?.timeout_ms || 8000),
    });
    const health = await probeCloudHealth(resolved.url, { timeoutMs: 10000 });
    return res.json({
      ok: true,
      discovery: resolved,
      cloud_health: health,
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: error.message || 'License discovery failed.',
      discovery_server_url: getDiscoveryServerUrl(),
    });
  }
});

router.get('/test-paychangu', requireDebugAccess, async (req, res) => {
  const secretConfigured = Boolean(process.env.PAYCHANGU_SECRET_KEY || process.env.PAYCHANGU_API_KEY);
  if (!secretConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'PAYCHANGU_SECRET_KEY is not configured on this server.',
    });
  }

  const probeUrl = `${PAYCHANGU_BASE_URL}/`;
  const result = await probeHttpEndpoint(probeUrl, {
    timeoutMs: Number(req.query?.timeout_ms || 8000),
    accept: 'application/json, text/plain, */*',
  });

  return res.json({
    ok: result.status > 0,
    message: 'Network reachability probe only. This does not create a charge.',
    paychangu_base_url: PAYCHANGU_BASE_URL,
    key_mode: String(process.env.PAYCHANGU_SECRET_KEY || '').startsWith('sec-test-') ? 'sandbox' : 'live_or_unknown',
    probe: result,
  });
});

router.get('/test-school', requireDebugAccess, async (req, res) => {
  const schoolId = String(req.query?.school_id || '').trim().toUpperCase();
  if (!schoolId) {
    return res.status(400).json({ error: 'school_id query parameter is required.' });
  }

  return res.json({
    ok: true,
    school_id: schoolId,
    database: getDatabaseDebugInfo(schoolId),
  });
});

router.get('/logs', requireDebugAccess, (req, res) => {
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
