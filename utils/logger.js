const REDACTED_KEYS = new Set([
  'authorization',
  'card_number',
  'cvv',
  'password',
  'paychangu_api_key',
  'paychangu_secret_key',
  'secret',
  'secret_key',
  'smtp_pass',
  'token',
]);

const MASKED_KEYS = new Set([
  'activation_code',
  'activation_key',
  'charge_id',
  'email',
  'internal_uid',
  'machine_hash',
  'phone_number',
  'school_email',
  'school_id',
]);

const MAX_LOG_ENTRIES = Number(process.env.OASIS_DEBUG_LOG_LIMIT || 1000);
const logEntries = [];

function maskValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw.length <= 8) return '*'.repeat(raw.length);
  return `${raw.slice(0, 4)}${'*'.repeat(raw.length - 8)}${raw.slice(-4)}`;
}

export function sanitizeForLog(value, key = '') {
  const normalizedKey = String(key || '').trim().toLowerCase();

  if (value === null || typeof value === 'undefined') {
    return value;
  }
  if (REDACTED_KEYS.has(normalizedKey)) {
    return '[redacted]';
  }
  if (MASKED_KEYS.has(normalizedKey)) {
    return maskValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, key));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeForLog(entryValue, entryKey),
      ])
    );
  }
  return value;
}

export function recordLog(level, event, details = {}) {
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    event,
    details: sanitizeForLog(details),
  };
  logEntries.push(entry);
  while (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }
  return entry;
}

export function getRecentLogs({ limit = 200, level, event } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit || 200), MAX_LOG_ENTRIES));
  const normalizedLevel = String(level || '').trim().toLowerCase();
  const normalizedEvent = String(event || '').trim().toLowerCase();
  return logEntries
    .filter((entry) => !normalizedLevel || entry.level === normalizedLevel)
    .filter((entry) => !normalizedEvent || String(entry.event || '').toLowerCase().includes(normalizedEvent))
    .slice(-normalizedLimit);
}

export function logInfo(event, details = {}) {
  const entry = recordLog('info', event, details);
  console.log(`[oasis-cloud] ${entry.timestamp} ${event}`, entry.details);
}

export function logWarn(event, details = {}) {
  const entry = recordLog('warn', event, details);
  console.warn(`[oasis-cloud] ${entry.timestamp} ${event}`, entry.details);
}

export function logError(event, error, details = {}) {
  const payload = {
    ...sanitizeForLog(details),
    error: {
      name: error?.name || null,
      message: error?.message || 'Unknown error',
      code: error?.code || null,
      status: Number(error?.statusCode || error?.status || 0) || null,
      stack: error?.stack || null,
    },
  };
  const entry = recordLog('error', event, payload);
  console.error(`[oasis-cloud] ${entry.timestamp} ${event}`, entry.details);
}
