const CACHE_TTL_MS = Number(process.env.OASIS_LICENSE_CACHE_TTL_MS || 5 * 60 * 1000);
const DEFAULT_EXPIRY_DAYS = Number(process.env.LICENSE_EXPIRY_DAYS || 365);
const ISSUER = process.env.LICENSE_ISSUER || 'oasis-cloud-license';
const PUBLIC_URL = String(process.env.OASIS_PUBLIC_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

const INLINE_CODES = [
  {
    code: 'OASIS-EMS-LIN-26-26',
    duration_days: 365,
    label: 'Annual License',
    enabled: true,
  },
  {
    code: 'OASIS-EMS-LIN-26-26-3',
    duration_days: 85,
    label: 'Five Year License',
    enabled: true,
  },
];

const PLAN_DATA = [
  {
    id: 'per-term',
    name: 'Per Term',
    duration_months: 3,
    price_kwacha: 350000,
  },
  {
    id: 'yearly',
    name: 'Yearly',
    duration_months: 12,
    price_kwacha: 800000,
  },
  {
    id: 'offline-yearly',
    name: 'Offline Yearly',
    duration_months: 12,
    price_kwacha: 800000,
    access_mode: 'offline',
  },
];

const cache = new Map();

function getCached(key, factory) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && now - existing.cached_at < CACHE_TTL_MS) {
    return existing.value;
  }
  const value = factory();
  cache.set(key, { value, cached_at: now });
  return value;
}

function normalizeCodes(records) {
  if (!Array.isArray(records)) return [];
  return records
    .map((item) => ({
      code: String(item?.code || '').trim(),
      durationDays: Number(item?.duration_days || item?.durationDays || DEFAULT_EXPIRY_DAYS),
      label: String(item?.label || '').trim(),
      enabled: item?.enabled !== false,
    }))
    .filter((item) => item.code && item.durationDays > 0 && item.enabled);
}

function loadCodes() {
  return getCached('activation_codes', () => normalizeCodes(INLINE_CODES));
}

function getUpdateResponse() {
  return getCached('check_update', () => {
    const updateValue = process.env.APP_UPDATE ?? process.env.UPDATE ?? '0';
    const downloadLinkValue = process.env.APP_UPDATE_LINK ?? process.env.UPDATE_LINK ?? '';
    const update = Number(updateValue) === 1 ? 1 : 0;
    const downloadLink = String(downloadLinkValue || '').trim();

    if (update === 0) {
      return { update, message: 'No update available.' };
    }

    return {
      update,
      message: downloadLink ? 'Update available.' : 'Update available, but no download link is configured.',
      download_link: downloadLink || null,
    };
  });
}

export function mountLicenseDiscoveryRoutes(app) {
  app.get('/health', (_req, res) => {
    res.json(getCached('health', () => ({
      status: 'ok',
      issuer: ISSUER,
      active_codes: loadCodes().length,
    })));
  });

  app.get('/check-update', (_req, res) => {
    res.json(getUpdateResponse());
  });

  app.get('/public-url', (_req, res) => {
    res.json(getCached('public_url', () => ({ url: PUBLIC_URL || null })));
  });

  app.get('/plans', (_req, res) => {
    res.json(getCached('plans', () => ({ plans: PLAN_DATA })));
  });

  app.post('/activate', (req, res) => {
    const activationKey = String(req.body?.activation_key || '').trim();
    if (!activationKey) {
      return res.status(400).json({ error: 'activation_key is required.' });
    }

    const matchedCode = loadCodes().find((entry) => entry.code === activationKey);
    if (!matchedCode) {
      return res.status(400).json({ error: 'Activation key is invalid.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (matchedCode.durationDays * 24 * 60 * 60);
    return res.json({
      issuer: ISSUER,
      code: matchedCode.code,
      label: matchedCode.label || null,
      duration_days: matchedCode.durationDays,
      issued_at: now,
      expires_at: expiresAt,
    });
  });
}

export function clearLicenseDiscoveryCache() {
  cache.clear();
}
