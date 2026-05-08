export const TRIAL_ACTIVATION_CODE = 'OASIS-EMS-LIN-26-26';
export const TRIAL_DURATION_DAYS = 365;
export const DIGITAL_SUBSCRIPTION_DURATION_DAYS = 365;

export function normalizeSubscriptionCountry(value) {
  return String(value || '').trim().toLowerCase() === 'nigeria' ? 'Nigeria' : 'Malawi';
}

export function getDigitalSubscriptionPlan(country) {
  const normalized = normalizeSubscriptionCountry(country);
  if (normalized === 'Nigeria') {
    return {
      country: normalized,
      amount: 300,
      currency: 'USD',
      durationDays: DIGITAL_SUBSCRIPTION_DURATION_DAYS,
      methods: [
        { code: 'visa', label: 'Visa', channel: 'card' },
        { code: 'mastercard', label: 'Mastercard', channel: 'card' },
      ],
    };
  }

  return {
    country: normalized,
    amount: 550000,
    currency: 'MWK',
    durationDays: DIGITAL_SUBSCRIPTION_DURATION_DAYS,
    methods: [
      { code: 'tnm', label: 'TNM MoMo', channel: 'mobile_money' },
      { code: 'airtel', label: 'Airtel Money', channel: 'mobile_money' },
    ],
  };
}

export function isDigitalMethodAllowed(country, method) {
  const plan = getDigitalSubscriptionPlan(country);
  return plan.methods.some((entry) => entry.code === String(method || '').trim().toLowerCase());
}

export function getDigitalMethodMeta(country, method) {
  const plan = getDigitalSubscriptionPlan(country);
  return plan.methods.find((entry) => entry.code === String(method || '').trim().toLowerCase()) || null;
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
