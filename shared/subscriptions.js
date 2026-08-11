import {
  buildActivationPayloadFromCode,
  findActivationCode,
  getConfiguredPlans,
  getTrialActivationCode,
  getTrialDurationDays,
  isTrialActivationCode,
  loadCommerceConfig,
} from './commerceConfig.js';

export const TRIAL_ACTIVATION_CODE = getTrialActivationCode();
export const TRIAL_DURATION_DAYS = getTrialDurationDays();

export {
  buildActivationPayloadFromCode,
  findActivationCode,
  getConfiguredPlans,
  isTrialActivationCode,
  loadCommerceConfig,
};
export const DIGITAL_SUBSCRIPTION_DURATION_DAYS = 365;

const DIGITAL_PAYMENT_METHODS = {
  Malawi: [
    { code: 'tnm', label: 'TNM MoMo', channel: 'mobile_money' },
    { code: 'airtel', label: 'Airtel Money', channel: 'mobile_money' },
  ],
};

export function normalizeSubscriptionCountry(_value) {
  return 'Malawi';
}

export function getDigitalPaymentMethods(_country) {
  return DIGITAL_PAYMENT_METHODS.Malawi.map((entry) => ({ ...entry }));
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

export function getFallbackDigitalSubscriptionCatalog(_country) {
  const commerce = loadCommerceConfig();
  const plans = getConfiguredPlans().map((entry) => buildNormalizedPlan({
    id: entry.id,
    name: entry.name,
    durationMonths: entry.duration_months,
    amount: entry.amount,
    currency: entry.currency || commerce.currency,
    accessMode: entry.access_mode,
  }));

  return {
    country: 'Malawi',
    currency: commerce.currency || 'MWK',
    methods: getDigitalPaymentMethods('Malawi'),
    plans,
    source: plans.length ? 'local' : 'unavailable',
  };
}

export function normalizeRemoteDigitalPlans(_country, payload) {
  const fallback = getFallbackDigitalSubscriptionCatalog('Malawi');
  const rawPlans = Array.isArray(payload?.plans) ? payload.plans : [];

  const plans = rawPlans.map((entry, index) => {
    const durationMonths = parsePositiveNumber(entry?.duration_months ?? entry?.durationMonths);
    if (!durationMonths) return null;

    const preferredCurrency = String(entry?.currency || '').trim().toUpperCase();
    const inferredCurrency = preferredCurrency || (entry?.price_kwacha ? 'MWK' : 'MWK');
    const amount = parsePositiveNumber(
      entry?.amount
      ?? entry?.price
      ?? entry?.price_kwacha
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
    country: 'Malawi',
    currency: plans[0]?.currency || fallback.currency,
    methods: fallback.methods,
    plans,
    source: 'remote',
  };
}

export function getDigitalSubscriptionPlan(_country) {
  const catalog = getFallbackDigitalSubscriptionCatalog('Malawi');
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

export function isDigitalMethodAllowed(_country, method) {
  return getDigitalPaymentMethods('Malawi')
    .some((entry) => entry.code === String(method || '').trim().toLowerCase());
}

export function getDigitalMethodMeta(_country, method) {
  return getDigitalPaymentMethods('Malawi')
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
