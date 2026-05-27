import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { bindSchoolContext, initializeDatabase } from './db/database.js';
import authRoutes from './routes/auth.js';
import classRoutes from './routes/classes.js';
import studentRoutes from './routes/students.js';
import subjectRoutes from './routes/subjects.js';
import examRoutes from './routes/exams.js';
import reportRoutes from './routes/reports.js';
import importRoutes from './routes/import.js';
import schoolRoutes from './routes/school.js';
import licenseRoutes from './routes/license.js';
import systemRoutes from './routes/system.js';
import analyticsRoutes from './routes/analytics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logError, logInfo, logWarn, sanitizeForLog } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
  node_env: process.env.NODE_ENV || null,
  passenger: Boolean(process.env.PASSENGER_APP_ENV || process.env.PASSENGER_BASE_URI),
});

const app = express();
const PORT = process.env.PORT || 3001;

function resolveTrustProxySetting() {
  const rawValue = process.env.OASIS_TRUST_PROXY;
  const value = String(rawValue ?? '').trim();

  if (!value) {
    return process.env.NODE_ENV === 'production' || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT
      ? 1
      : false;
  }

  if (/^(false|0|no|off)$/i.test(value)) return false;
  if (/^(true|1|yes|on)$/i.test(value)) return 1;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : value;
}

const trustProxy = resolveTrustProxySetting();
if (trustProxy !== false) {
  app.set('trust proxy', trustProxy);
}
logInfo('startup.trust_proxy', { trust_proxy: trustProxy });

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

// CORS configuration
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
    // Electron file:// requests and same-process requests may send no origin.
    if (!origin || origin === 'null' || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    logWarn('cors.origin_rejected', { origin, allowed_origins: [...allowedOrigins] });
    return callback(new Error('CORS not allowed for this origin'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
logInfo('startup.cors_configured', {
  allowed_origins: [...allowedOrigins],
  allows_null_origin: true,
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Stricter rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 login attempts per hour
  message: { error: 'Too many login attempts, please try again later.' }
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;
  logInfo('request.start', {
    request_id: requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    origin: req.headers.origin || null,
    user_agent: req.headers['user-agent'] || null,
    school_id: req.query?.school_id || req.body?.school_id || null,
    body: req.method === 'GET' ? undefined : sanitizeForLog(req.body || {}),
  });
  res.on('finish', () => {
    logInfo('request.finish', {
      request_id: requestId,
      method: req.method,
      path: req.originalUrl,
      status_code: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });
  next();
});
app.use(bindSchoolContext);

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

try {
  initializeDatabase();
  logInfo('startup.database_ready', {
    mode: process.env.OASIS_DB_MODE || (process.env.MYSQL_HOST ? 'mysql' : 'sqlite'),
  });
} catch (error) {
  logError('startup.database_failed', error);
  throw error;
}

// Routes
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    request_id: req.requestId || null,
    environment: {
      node_env: process.env.NODE_ENV || null,
      passenger: Boolean(process.env.PASSENGER_APP_ENV || process.env.PASSENGER_BASE_URI),
      uploads_dir: uploadsDir,
      data_dir: process.env.OASIS_DATA_DIR || null,
      cors_origin_count: allowedOrigins.size,
    },
  });
});

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  logWarn('request.not_found', {
    request_id: req.requestId || null,
    method: req.method,
    path: req.originalUrl,
  });
  res.status(404).json({ error: 'Not found' });
});

process.on('uncaughtException', (error) => {
  logError('process.uncaught_exception', error);
});

process.on('unhandledRejection', (reason) => {
  logError('process.unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

app.listen(PORT, () => {
  logInfo('startup.listen', {
    port: PORT,
    message: `Server running on http://localhost:${PORT}`,
  });
  logInfo('startup.ready', { message: 'School Grading System API ready' });
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📚 School Grading System API ready`);
});

export default app;
