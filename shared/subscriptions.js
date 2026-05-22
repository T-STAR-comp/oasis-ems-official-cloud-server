export const TRIAL_ACTIVATION_CODE = 'OASIS-EMS-LIN-26-26';
export const TRIAL_DURATION_DAYS = 365;
export const DIGITAL_SUBSCRIPTION_DURATION_DAYS = 365;

const DIGITAL_PAYMENT_METHODS = {
  Nigeria: [
    { code: 'visa', label: 'Visa', channel: 'card' },
    { code: 'mastercard', label: 'Mastercard', channel: 'card' },
  ],
  Malawi: [
    { code: 'tnm', label: 'TNM MoMo', channel: 'mobile_money' },
    { code: 'airtel', label: 'Airtel Money', channel: 'mobile_money' },
  ],
};

export function normalizeSubscriptionCountry(value) {
  return String(value || '').trim().toLowerCase() === 'nigeria' ? 'Nigeria' : 'Malawi';
}

export function getDigitalPaymentMethods(country) {
  const normalized = normalizeSubscriptionCountry(country);
  return (DIGITAL_PAYMENT_METHODS[normalized] || []).map((entry) => ({ ...entry }));
}

export function convertPlanMonthsToDays(durationMonths) {
  const months = Number(durationMonths || 0);
  if (!Number.isFinite(months) || months <= 0) {
    return DIGITAL_SUBSCRIPTION_DURATION_DAYS;
  }
  return Math.max(1, Math.round((months * 365) / 12));
}

function parsePositiveNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function buildNormalizedPlan({
  id,
  name,
  durationMonths,
  amount,
  currency,
  accessMode = 'online',
}) {
  const normalizedAccessMode = String(accessMode || '').trim().toLowerCase() === 'offline'
    ? 'offline'
    : 'online';
  return {
    id: String(id || '').trim().toLowerCase(),
    name: String(name || '').trim(),
    access_mode: normalizedAccessMode,
    online_features_enabled: normalizedAccessMode === 'online',
    duration_months: Number(durationMonths || 0),
    duration_days: convertPlanMonthsToDays(durationMonths),
    amount: Number(amount || 0),
    currency: String(currency || '').trim().toUpperCase(),
    price_kwacha: String(currency || '').trim().toUpperCase() === 'MWK'
      ? Number(amount || 0)
      : null,
  };
}

export function getFallbackDigitalSubscriptionCatalog(country) {
  const normalized = normalizeSubscriptionCountry(country);
  const methods = getDigitalPaymentMethods(normalized);

  if (normalized === 'Nigeria') {
    const plans = [
      buildNormalizedPlan({
        id: 'yearly',
        name: 'Yearly',
        durationMonths: 12,
        amount: 300,
        currency: 'USD',
      }),
    ];

    return {
      country: normalized,
      currency: 'USD',
      methods,
      plans,
      source: 'fallback',
    };
  }

  const plans = [
    buildNormalizedPlan({
      id: 'online-per-term',
      name: 'Online Per Term',
      durationMonths: 3,
      amount: 350000,
      currency: 'MWK',
      accessMode: 'online',
    }),
    buildNormalizedPlan({
      id: 'online-yearly',
      name: 'Online Yearly',
      durationMonths: 12,
      amount: 800000,
      currency: 'MWK',
      accessMode: 'online',
    }),
    buildNormalizedPlan({
      id: 'offline-per-term',
      name: 'Offline Per Term',
      durationMonths: 3,
      amount: 270000,
      currency: 'MWK',
      accessMode: 'offline',
    }),
    buildNormalizedPlan({
      id: 'offline-yearly',
      name: 'Offline Yearly',
      durationMonths: 12,
      amount: 700000,
      currency: 'MWK',
      accessMode: 'offline',
    }),
  ];

  return {
    country: normalized,
    currency: 'MWK',
    methods,
    plans,
    source: 'fallback',
  };
}

export function normalizeRemoteDigitalPlans(country, payload) {
  const normalized = normalizeSubscriptionCountry(country);
  const fallback = getFallbackDigitalSubscriptionCatalog(normalized);
  const rawPlans = Array.isArray(payload?.plans) ? payload.plans : [];

  const plans = rawPlans.map((entry, index) => {
    const durationMonths = parsePositiveNumber(entry?.duration_months ?? entry?.durationMonths);
    if (!durationMonths) return null;

    const preferredCurrency = String(entry?.currency || '').trim().toUpperCase();
    const inferredCurrency = preferredCurrency
      || (normalized === 'Malawi' || entry?.price_kwacha ? 'MWK' : 'USD');
    const amount = parsePositiveNumber(
      entry?.amount
      ?? entry?.price
      ?? entry?.price_kwacha
      ?? entry?.price_usd
      ?? entry?.price_naira
    );

    if (!amount) return null;

    const id = String(entry?.id || '').trim().toLowerCase() || `plan-${index + 1}`;
    const name = String(entry?.name || '').trim() || `Plan ${index + 1}`;
    const accessMode = String(entry?.access_mode ?? entry?.accessMode ?? '').trim().toLowerCase() === 'offline'
      ? 'offline'
      : 'online';

    return buildNormalizedPlan({
      id,
      name,
      durationMonths,
      amount,
      currency: inferredCurrency,
      accessMode,
    });
  }).filter(Boolean);

  if (!plans.length) {
    return fallback;
  }

  return {
    country: normalized,
    currency: plans[0]?.currency || fallback.currency,
    methods: fallback.methods,
    plans,
    source: 'remote',
  };
}

export function getDigitalSubscriptionPlan(country) {
  const catalog = getFallbackDigitalSubscriptionCatalog(country);
  const plan = catalog.plans[0] || null;
  if (!plan) return null;

  return {
    country: catalog.country,
    amount: plan.amount,
    currency: plan.currency,
    durationDays: plan.duration_days,
    methods: catalog.methods,
  };
}

export function isDigitalMethodAllowed(country, method) {
  return getDigitalPaymentMethods(country)
    .some((entry) => entry.code === String(method || '').trim().toLowerCase());
}

export function getDigitalMethodMeta(country, method) {
  return getDigitalPaymentMethods(country)
    .find((entry) => entry.code === String(method || '').trim().toLowerCase()) || null;
}

export function splitFullName(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return { firstName: '', lastName: '' };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || parts[0] || '',
  };
}

export function calculateExpiryUnix(durationDays, issuedAt = Math.floor(Date.now() / 1000)) {
  const days = Number(durationDays || 0);
  return issuedAt + Math.max(0, days) * 24 * 60 * 60;
}
