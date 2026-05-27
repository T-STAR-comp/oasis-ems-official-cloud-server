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

export function logInfo(event, details = {}) {
  console.log(`[oasis-cloud] ${new Date().toISOString()} ${event}`, sanitizeForLog(details));
}

export function logWarn(event, details = {}) {
  console.warn(`[oasis-cloud] ${new Date().toISOString()} ${event}`, sanitizeForLog(details));
}

export function logError(event, error, details = {}) {
  console.error(`[oasis-cloud] ${new Date().toISOString()} ${event}`, {
    ...sanitizeForLog(details),
    error: {
      name: error?.name || null,
      message: error?.message || 'Unknown error',
      code: error?.code || null,
      status: Number(error?.statusCode || error?.status || 0) || null,
      stack: error?.stack || null,
    },
  });
}
