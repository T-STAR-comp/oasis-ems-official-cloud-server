import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { jsonApiHeaders } from './middleware/jsonApi.js';
import { logError, logInfo, logWarn, sanitizeForLog } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isPassengerRuntime() {
  return Boolean(
    process.env.PASSENGER_APP_ENV ||
    process.env.PASSENGER_BASE_URI ||
    process.env.PHUSION_PASSENGER
  );
}

function resolveTrustProxySetting() {
  const rawValue = process.env.OASIS_TRUST_PROXY;
  const value = String(rawValue ?? '').trim();

  if (!value) {
    return process.env.NODE_ENV === 'production' || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT || isPassengerRuntime()
      ? 1
      : false;
  }

  if (/^(false|0|no|off)$/i.test(value)) return false;
  if (/^(true|1|yes|on)$/i.test(value)) return 1;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : value;
}

function buildRootPayload(req, boot = {}) {
  return {
    service: 'oasis-ems-cloud',
    status: boot.ready === false ? 'starting' : 'ok',
    message: 'Oasis EMS cloud API',
    timestamp: new Date().toISOString(),
    request_id: req.requestId || null,
    boot,
    links: {
      health: '/api/health',
      ping: '/api/debug/ping',
      diagnostics: '/api/debug/diagnostics',
    },
  };
}

function buildHealthPayload(req, boot = {}) {
  const defaultUploadsDir = process.env.VERCEL ? '/tmp/oasis-uploads' : path.join(__dirname, 'uploads');
  const uploadsDir = process.env.OASIS_UPLOADS_DIR
    ? path.resolve(process.env.OASIS_UPLOADS_DIR)
    : defaultUploadsDir;

  return {
    status: boot.ready === false ? 'starting' : 'ok',
    service: 'oasis-ems-cloud',
    timestamp: new Date().toISOString(),
    request_id: req.requestId || null,
    boot,
    environment: {
      node_env: process.env.NODE_ENV || null,
      passenger: isPassengerRuntime(),
      passenger_base_uri: process.env.PASSENGER_BASE_URI || null,
      uploads_dir: uploadsDir,
      data_dir: process.env.OASIS_DATA_DIR || null,
      database_mode: process.env.OASIS_USE_MYSQL === 'true' || process.env.OASIS_USE_MYSQL === '1'
        ? 'mysql'
        : 'sqlite',
    },
  };
}

function renderRootHtml(boot = {}) {
  const status = boot.ready === false ? 'starting' : 'ok';
  const detail = boot.error ? `<p><strong>Boot note:</strong> ${boot.error}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Oasis EMS Cloud API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f4f4f5; padding: 0.1rem 0.35rem; border-radius: 4px; }
    .ok { color: #166534; }
    .warn { color: #92400e; }
  </style>
</head>
<body>
  <h1>Oasis EMS Cloud API</h1>
  <p class="${status === 'ok' ? 'ok' : 'warn'}">Status: <strong>${status}</strong></p>
  ${detail}
  <p>JSON health: <a href="/api/health"><code>/api/health</code></a></p>
  <p>Quick ping: <a href="/api/debug/ping"><code>/api/debug/ping</code></a></p>
</body>
</html>`;
}

/** Public routes only — safe before database and API modules load. */
export function createBaseApp() {
  const app = express();
  const boot = {
    ready: false,
    error: null,
    started_at: new Date().toISOString(),
  };
  app.locals.boot = boot;

  const trustProxy = resolveTrustProxySetting();
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  app.use(jsonApiHeaders);

  app.use((req, res, next) => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    req.requestId = requestId;
    next();
  });

  const sendRoot = (req, res) => {
    const payload = buildRootPayload(req, boot);
    if (req.accepts(['html', 'json']) === 'html') {
      res.type('html').send(renderRootHtml(boot));
      return;
    }
    res.json(payload);
  };

  app.get('/', sendRoot);
  app.get('/index.html', sendRoot);

  app.get(['/health', '/api/health', '/api/health.json'], (req, res) => {
    res.json(buildHealthPayload(req, boot));
  });

  return app;
}

export async function mountFullStack(app) {
  const boot = app.locals.boot;
  const defaultUploadsDir = process.env.VERCEL ? '/tmp/oasis-uploads' : path.join(__dirname, 'uploads');
  const uploadsDir = process.env.OASIS_UPLOADS_DIR
    ? path.resolve(process.env.OASIS_UPLOADS_DIR)
    : defaultUploadsDir;

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  logInfo('startup.paths_resolved', {
    dirname: __dirname,
    uploads_dir: uploadsDir,
    data_dir: process.env.OASIS_DATA_DIR || null,
    passenger: isPassengerRuntime(),
  });

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));

  const allowedOrigins = new Set([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...String(process.env.OASIS_CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || origin === 'null' || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      logWarn('cors.origin_rejected', { origin });
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/' || req.path === '/health' || req.path.startsWith('/api/health'),
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    logInfo('request.start', {
      request_id: req.requestId || null,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
    });
    res.on('finish', () => {
      logInfo('request.finish', {
        request_id: req.requestId || null,
        method: req.method,
        path: req.originalUrl,
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });
    next();
  });

  const { bindSchoolContext, initializeDatabase } = await import('./db/database.js');
  const authRoutes = (await import('./routes/auth.js')).default;
  const classRoutes = (await import('./routes/classes.js')).default;
  const studentRoutes = (await import('./routes/students.js')).default;
  const subjectRoutes = (await import('./routes/subjects.js')).default;
  const examRoutes = (await import('./routes/exams.js')).default;
  const reportRoutes = (await import('./routes/reports.js')).default;
  const importRoutes = (await import('./routes/import.js')).default;
  const schoolRoutes = (await import('./routes/school.js')).default;
  const licenseRoutes = (await import('./routes/license.js')).default;
  const systemRoutes = (await import('./routes/system.js')).default;
  const analyticsRoutes = (await import('./routes/analytics.js')).default;
  const debugRoutes = (await import('./routes/debug.js')).default;
  const { errorHandler } = await import('./middleware/errorHandler.js');

  app.use(bindSchoolContext);
  app.use('/uploads', express.static(uploadsDir));

  try {
    initializeDatabase();
    logInfo('startup.database_ready', {
      mode: process.env.OASIS_USE_MYSQL === 'true' || process.env.OASIS_USE_MYSQL === '1' ? 'mysql' : 'sqlite',
    });
  } catch (error) {
    boot.error = error?.message || 'Database initialization failed';
    logError('startup.database_failed', error);
  }

  const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts, please try again later.' },
  });

  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/classes', classRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/subjects', subjectRoutes);
  app.use('/api/exams', examRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/import', importRoutes);
  app.use('/api/school', schoolRoutes);
  app.use('/api/license', licenseRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/debug', debugRoutes);

  app.use((req, res, next) => {
    if (!boot.ready && !boot.error && req.path.startsWith('/api/') && !req.path.startsWith('/api/health')) {
      return res.status(503).json({
        error: 'API is still starting. Retry in a few seconds.',
        boot,
      });
    }
    return next();
  });

  app.use(errorHandler);

  app.use((req, res) => {
    logWarn('request.not_found', {
      request_id: req.requestId || null,
      method: req.method,
      path: req.originalUrl,
    });
    res.status(404).json({
      error: 'Not found',
      path: req.originalUrl,
      hint: 'Try GET / or GET /api/health',
    });
  });

  boot.ready = !boot.error;
  boot.finished_at = new Date().toISOString();
  logInfo('startup.ready', { ready: boot.ready, error: boot.error });
}
