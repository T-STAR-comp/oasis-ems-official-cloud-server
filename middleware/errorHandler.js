import { logError } from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  logError('request.error', err, {
    request_id: req.requestId || null,
    method: req.method,
    path: req.originalUrl,
    status: err.statusCode || err.status || null,
    school_id: req.query?.school_id || req.body?.school_id || req.user?.school_id || null,
  });

  // SQLite constraint errors
  if (err.code === 'SQLITE_CONSTRAINT') {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A record with this value already exists' });
    }
    if (err.message.includes('FOREIGN KEY')) {
      return res.status(400).json({ error: 'Referenced record does not exist' });
    }
    return res.status(400).json({ error: 'Database constraint violation' });
  }

  // Validation errors from express-validator
  if (err.array && typeof err.array === 'function') {
    return res.status(400).json({ 
      error: 'Validation failed',
      details: err.array()
    });
  }

  // Multer file upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 10MB' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }

  // Default error
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

// Custom error class for API errors
export class ApiError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}
