import express from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import db, { runWithSchoolContext } from '../db/database.js';
import {
  DIGITAL_SUBSCRIPTION_DURATION_DAYS,
  TRIAL_ACTIVATION_CODE,
  TRIAL_DURATION_DAYS,
  calculateExpiryUnix,
  getDigitalMethodMeta,
  getDigitalSubscriptionPlan,
  isDigitalMethodAllowed,
  normalizeSubscriptionCountry,
  splitFullName,
} from '../shared/subscriptions.js';

const router = express.Router();

const LICENSE_SERVER_URL = String(
  process.env.OASIS_LICENSE_SERVER_URL || ''
).trim().replace(/\/+$/, '');
const PAYCHANGU_BASE_URL = String(process.env.PAYCHANGU_BASE_URL || 'https://api.paychangu.com').trim().replace(/\/+$/, '');
const PAYCHANGU_SECRET_KEY = String(
  process.env.PAYCHANGU_SECRET_KEY || process.env.PAYCHANGU_API_KEY || ''
).trim();
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER || 'no-reply@oasis-ems.local').trim();
const PAYMENT_LOG_INCLUDE_FULL_ACTIVATION_CODES = String(
  process.env.PAYMENT_LOG_INCLUDE_FULL_ACTIVATION_CODES || 'false'
).trim().toLowerCase() === 'true';
const MALAWI_TEST_PAYCHANGU_AMOUNT = 50;
const PENDING_VERIFICATION_WINDOW_MS = 5 * 60 * 1000;
const PENDING_VERIFICATION_WINDOW_MINUTES = 5;
const PAYMENT_LOG_PREFIX = '[payment-flow]';
const PAYCHANGU_TEST_KEY_PREFIX = 'sec-test-';
const PAYCHANGU_SANDBOX_MALAWI_MOBILE_NUMBERS = {
  airtel: {
    label: 'Airtel Money',
    success: '990000000',
    failed: '990000001',
  },
  tnm: {
    label: 'TNM Mpamba',
    success: '899817565',
    failed: '899817566',
  },
};

const FULLY_REDACTED_LOG_KEYS = new Set([
  'authorization',
  'api_key',
  'cvv',
  'password',
  'paychangu_api_key',
  'paychangu_secret_key',
  'secret',
  'secret_key',
  'smtp_pass',
  'token',
]);

const PARTIALLY_MASKED_LOG_KEYS = new Set([
  'activation_code',
  'activation_key',
  'app_secret',
  'card_number',
  'charge_id',
  'email',
  'internal_uid',
  'machine_hash',
  'mobile',
  'phone_number',
  'school_email',
]);

function normalizeSchoolId(value) {
  return String(value || '').trim().toUpperCase();
}

function isPaychanguSandboxKey() {
  return PAYCHANGU_SECRET_KEY.startsWith(PAYCHANGU_TEST_KEY_PREFIX);
}

function maskValue(value, { visibleStart = 2, visibleEnd = 2 } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw.length <= visibleStart + visibleEnd) {
    return '*'.repeat(raw.length);
  }
  return `${raw.slice(0, visibleStart)}${'*'.repeat(raw.length - visibleStart - visibleEnd)}${raw.slice(-visibleEnd)}`;
}

function maskEmail(value) {
  const email = String(value || '').trim();
  if (!email.includes('@')) return maskValue(email, { visibleStart: 1, visibleEnd: 1 });
  const [localPart, domain] = email.split('@');
  return `${maskValue(localPart, { visibleStart: 1, visibleEnd: 1 })}@${domain}`;
}

function sanitizePaymentLogValue(value, key = '') {
  const normalizedKey = String(key || '').trim().toLowerCase();

  if (value === null || typeof value === 'undefined') {
    return value;
  }

  if (FULLY_REDACTED_LOG_KEYS.has(normalizedKey)) {
    return '[redacted]';
  }

  if (normalizedKey === 'email' || normalizedKey === 'school_email') {
    return maskEmail(value);
  }

  if (
    PAYMENT_LOG_INCLUDE_FULL_ACTIVATION_CODES &&
    (normalizedKey === 'activation_code' || normalizedKey === 'activation_key')
  ) {
    return String(value);
  }

  if (normalizedKey === 'card_number') {
    return maskValue(value, { visibleStart: 0, visibleEnd: 4 });
  }

  if (
    normalizedKey === 'mobile' ||
    normalizedKey === 'phone_number' ||
    normalizedKey === 'activation_code' ||
    normalizedKey === 'activation_key' ||
    normalizedKey === 'charge_id' ||
    normalizedKey === 'internal_uid' ||
    normalizedKey === 'machine_hash' ||
    PARTIALLY_MASKED_LOG_KEYS.has(normalizedKey)
  ) {
    return maskValue(value, { visibleStart: 4, visibleEnd: 4 });
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePaymentLogValue(item, key));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizePaymentLogValue(entryValue, entryKey),
      ])
    );
  }

  return value;
}

function logPaymentEvent(event, details = {}) {
  console.log(
    `${PAYMENT_LOG_PREFIX} ${new Date().toISOString()} ${event}`,
    sanitizePaymentLogValue(details)
  );
}

function logPaymentError(event, error, details = {}) {
  const payload = sanitizePaymentLogValue(details);
  console.error(`${PAYMENT_LOG_PREFIX} ${new Date().toISOString()} ${event}`, {
    ...payload,
    error: {
      message: error?.message || 'Unknown payment error.',
      stack: error?.stack || null,
      statusCode: Number(error?.statusCode || error?.status || 0) || null,
    },
  });
}

function createHttpError(message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  Object.assign(error, details);
  return error;
}

function unixToIso(value) {
  const numeric = Number(value || 0);
  if (!numeric) return null;
  return new Date(numeric * 1000).toISOString();
}

function timestampToIso(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return null;
  return new Date(timestamp).toISOString();
}

function sanitizePhoneNumberForProvider(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function normalizeMobileNumberForComparison(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('265') && digits.length > 9) {
    digits = digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length >= 10) {
    digits = digits.slice(1);
  }
  return digits;
}

function buildSandboxMobileMoneyWarning(paymentMethod, phoneNumber, providerMode) {
  const normalizedMode = String(providerMode || '').trim().toLowerCase();
  const sandboxMode = normalizedMode === 'sandbox' || normalizedMode === 'test' || (!normalizedMode && isPaychanguSandboxKey());
  if (!sandboxMode) {
    return null;
  }

  const provider = PAYCHANGU_SANDBOX_MALAWI_MOBILE_NUMBERS[String(paymentMethod || '').trim().toLowerCase()];
  const recommended = provider
    ? `${provider.success} (success) or ${provider.failed} (failed) for ${provider.label}`
    : 'a PayChangu sandbox mobile money test number';
  const normalizedPhone = normalizeMobileNumberForComparison(phoneNumber);

  if (provider && normalizedPhone && normalizedPhone !== provider.success && normalizedPhone !== provider.failed) {
    return `PayChangu is in sandbox mode, so a real PIN prompt will not be sent to this phone. Use ${recommended}, or switch the cloud server to a live PayChangu secret key.`;
  }

  return `PayChangu is in sandbox mode. Real handset PIN prompts are not sent in sandbox; use ${recommended}, or switch the cloud server to a live PayChangu secret key.`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

function assertLegacyLicenseServerConfigured() {
  if (!LICENSE_SERVER_URL) {
    throw createHttpError('OASIS_LICENSE_SERVER_URL is not configured for manual activation proxying.', 503);
  }
}

function assertPaychanguConfigured() {
  if (!PAYCHANGU_SECRET_KEY) {
    throw new Error('PAYCHANGU_SECRET_KEY is not configured on the cloud server.');
  }
}

async function paychanguRequest(endpoint, { method = 'GET', body, logContext = {} } = {}) {
  assertPaychanguConfigured();
  const url = `${PAYCHANGU_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const startedAt = Date.now();
  logPaymentEvent('paychangu.request.start', {
    ...logContext,
    endpoint,
    method,
    url,
    request_body: body || null,
  });

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    logPaymentError('paychangu.request.network_error', error, {
      ...logContext,
      endpoint,
      method,
      url,
      duration_ms: Date.now() - startedAt,
      request_body: body || null,
    });
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  const durationMs = Date.now() - startedAt;
  logPaymentEvent(response.ok ? 'paychangu.request.success' : 'paychangu.request.failure', {
    ...logContext,
    endpoint,
    method,
    url,
    status_code: response.status,
    duration_ms: durationMs,
    request_body: body || null,
    response_body: data,
  });

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `PayChangu request failed (${response.status}).`);
  }
  return data;
}

function parseMetadata(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (_error) {
    return {};
  }
}

function getMailTransport() {
  if (!SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

async function sendActivationEmail({ email, code, durationDays, label, schoolId }) {
  const transporter = getMailTransport();
  if (!transporter) {
    logPaymentEvent('payment.email.skipped', {
      school_id: schoolId,
      email,
      duration_days: durationDays,
      label,
      reason: 'SMTP is not configured on the cloud server.',
    });
    return { ok: false, error: 'SMTP is not configured on the cloud server.' };
  }

  const subject = 'Oasis EMS Digital Subscription Activation Code';
  const lines = [
    'Hello,',
    '',
    'Your Oasis EMS payment was verified successfully.',
    '',
    'Use this activation code to finish your digital subscription setup:',
    '',
    code,
    '',
    `School ID: ${schoolId || 'N/A'}`,
    `License duration: ${durationDays} days`,
  ];
  if (label) {
    lines.push(`Plan: ${label}`);
  }
  lines.push('', 'Enter this code in Oasis EMS to activate online access.', '', 'Regards,', 'Oasis EMS Team');

  logPaymentEvent('payment.email.start', {
    school_id: schoolId,
    email,
    activation_code: code,
    duration_days: durationDays,
    label,
  });

  await transporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject,
    text: lines.join('\n'),
  });

  logPaymentEvent('payment.email.success', {
    school_id: schoolId,
    email,
    activation_code: code,
    duration_days: durationDays,
    label,
  });

  return { ok: true };
}

function isPaychanguPaymentSuccessful(payload) {
  const status = String(
    payload?.status ||
      payload?.data?.status ||
      payload?.data?.state ||
      payload?.data?.payment_status ||
      payload?.data?.charge_status ||
      ''
  ).toLowerCase();

  if (status.includes('success') || status.includes('paid') || status.includes('completed')) return true;
  if (payload?.data?.paid === true || payload?.paid === true) return true;
  return false;
}

function syncSchoolInfo({ schoolId, country, schoolName, schoolEmail }) {
  const row = db.prepare('SELECT id FROM school_info WHERE id = 1').get();
  if (!row) return;
  db.prepare(`
    UPDATE school_info
    SET school_id = COALESCE(?, school_id),
        country = COALESCE(?, country),
        name = CASE WHEN ? != '' THEN ? ELSE name END,
        email = CASE WHEN ? != '' THEN ? ELSE email END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    schoolId || null,
    country || null,
    schoolName || '',
    schoolName || '',
    schoolEmail || '',
    schoolEmail || ''
  );
}

function extractOperatorEntries(payload) {
  const entries = [];
  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item && typeof item === 'object') {
          entries.push(item);
        }
        walk(item);
      });
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(payload);
  return entries;
}

async function resolveMobileMoneyOperatorRefId(methodCode, logContext = {}) {
  logPaymentEvent('paychangu.mobile_money.operator_lookup.start', {
    ...logContext,
    requested_method: methodCode,
  });
  const payload = await paychanguRequest('/mobile-money', { logContext });
  const operators = extractOperatorEntries(payload);
  const needle = String(methodCode || '').trim().toLowerCase();
  const exactShortCodeMatch = operators.find((entry) => String(entry?.short_code || '').trim().toLowerCase() === needle);
  const nameMatch = operators.find((entry) => String(entry?.name || entry?.operator_name || '').trim().toLowerCase().includes(needle));
  const refMatch = operators.find((entry) => String(entry?.ref_id || entry?.operator_ref_id || entry?.mobile_money_operator_ref_id || '').trim().toLowerCase() === needle);
  const match = exactShortCodeMatch || nameMatch || refMatch;
  const refId =
    match?.mobile_money_operator_ref_id ||
    match?.operator_ref_id ||
    match?.ref_id ||
    match?.id ||
    null;
  if (!refId) {
    throw new Error(`Could not find a PayChangu operator for ${needle}.`);
  }
  logPaymentEvent('paychangu.mobile_money.operator_lookup.success', {
    ...logContext,
    requested_method: methodCode,
    resolved_operator_ref_id: refId,
    matched_operator: match || null,
  });
  return String(refId);
}

function generateActivationCode(existingCodes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const makeGroup = () => {
    let group = '';
    for (let index = 0; index < 4; index += 1) {
      group += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return group;
  };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `OASIS-${makeGroup()}-${makeGroup()}-${makeGroup()}`;
    if (!existingCodes.has(code)) {
      return code;
    }
  }

  throw new Error('Failed to generate a unique digital activation code.');
}

function generateUniqueDigitalActivationCode() {
  const existingCodes = new Set(
    db.prepare(`
      SELECT activation_code
      FROM subscription_records
      WHERE activation_code IS NOT NULL AND activation_code != ''
    `).all().map((row) => String(row?.activation_code || '').trim()).filter(Boolean)
  );

  return generateActivationCode(existingCodes);
}

function buildDigitalActivationPayload(record, schoolId) {
  const activatedAtIso = record?.activated_at || new Date().toISOString();
  const expiresAtIso = record?.expires_at || new Date(calculateExpiryUnix(
    Number(record?.duration_days || DIGITAL_SUBSCRIPTION_DURATION_DAYS)
  ) * 1000).toISOString();

  return {
    issuer: 'oasis-cloud-digital',
    code: String(record?.activation_code || '').trim(),
    label: 'Digital Subscription',
    school_id: normalizeSchoolId(schoolId || record?.school_id) || null,
    duration_days: Number(record?.duration_days || DIGITAL_SUBSCRIPTION_DURATION_DAYS),
    issued_at: Math.floor(new Date(activatedAtIso).getTime() / 1000),
    expires_at: Math.floor(new Date(expiresAtIso).getTime() / 1000),
  };
}

function getPendingVerificationDeadline(record) {
  const createdAtMs = new Date(record?.created_at || 0).getTime();
  if (!createdAtMs) return 0;
  return createdAtMs + PENDING_VERIFICATION_WINDOW_MS;
}

function readEmailErrorFromMetadata(record) {
  const metadata = parseMetadata(record?.metadata);
  return String(metadata?.email_result?.error || '').trim() || null;
}

function readEmailSentFromMetadata(record) {
  const metadata = parseMetadata(record?.metadata);
  return metadata?.email_result?.ok === true;
}

function findLatestDigitalLedgerRecordBySchool(schoolId, statuses = ['pending', 'pending_activation']) {
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT *
    FROM subscription_records
    WHERE school_id = ?
      AND plan_kind = 'digital_online'
      AND status IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT 1
  `).get(schoolId, ...statuses);
}

function markLedgerRecordFailed(record, reason) {
  const metadata = {
    ...parseMetadata(record?.metadata),
    failure_reason: reason,
    failed_at: new Date().toISOString(),
  };
  db.prepare(`
    UPDATE subscription_records
    SET status = 'failed',
        metadata = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(metadata), record.id);
}

function insertSubscriptionRecord({
  schoolId,
  country,
  adminEmail,
  adminName,
  planKind,
  status,
  activationCode,
  chargeId,
  paymentMethod,
  paymentChannel,
  amount,
  currency,
  durationDays,
  onlineFeaturesEnabled,
  internalUid,
  machineHash,
  metadata,
  activatedAt,
  expiresAt,
}) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO subscription_records (
      id, school_id, country, admin_email, admin_name, plan_kind, status,
      activation_code, charge_id, payment_method, payment_channel, amount, currency,
      duration_days, online_features_enabled, internal_uid, machine_hash, metadata,
      activated_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    schoolId || null,
    country,
    adminEmail || null,
    adminName || null,
    planKind,
    status,
    activationCode || null,
    chargeId || null,
    paymentMethod || null,
    paymentChannel || null,
    Number(amount || 0) || null,
    currency || null,
    Number(durationDays || 0),
    onlineFeaturesEnabled ? 1 : 0,
    internalUid || null,
    machineHash || null,
    metadata ? JSON.stringify(metadata) : null,
    activatedAt || null,
    expiresAt || null
  );
  return id;
}

router.post('/trial/activate', async (req, res) => {
  try {
    const schoolId = normalizeSchoolId(req.body?.school_id);
    if (!schoolId) {
      return res.status(400).json({ error: 'school_id is required.' });
    }

    const activationKey = String(req.body?.activation_key || '').trim();
    if (activationKey !== TRIAL_ACTIVATION_CODE) {
      return res.status(400).json({ error: 'Invalid trial activation code.' });
    }

    const country = normalizeSubscriptionCountry(req.body?.country);
    const schoolName = String(req.body?.school_name || '').trim();
    const schoolEmail = String(req.body?.school_email || '').trim().toLowerCase();
    const internalUid = String(req.body?.internal_uid || '').trim();
    const machineHash = String(req.body?.machine_hash || '').trim();

    const result = await runWithSchoolContext(schoolId, async () => {
      syncSchoolInfo({ schoolId, country, schoolName, schoolEmail });

      const existing = db.prepare(`
        SELECT *
        FROM subscription_records
        WHERE plan_kind = 'trial'
        ORDER BY created_at DESC
        LIMIT 1
      `).get();

      const now = Math.floor(Date.now() / 1000);
      if (existing) {
        const sameInternalUid = internalUid && existing.internal_uid && existing.internal_uid === internalUid;
        const expiresAt = Math.floor(new Date(existing.expires_at || 0).getTime() / 1000);
        if (sameInternalUid && expiresAt > now) {
          return {
            issuer: 'oasis-cloud-trial',
            code: TRIAL_ACTIVATION_CODE,
            label: 'Free Trial',
            school_id: schoolId,
            duration_days: existing.duration_days || TRIAL_DURATION_DAYS,
            issued_at: Math.floor(new Date(existing.activated_at || Date.now()).getTime() / 1000),
            expires_at: expiresAt,
          };
        }
        throw createHttpError('Free trial has already been used for this school.', 409);
      }

      const issuedAt = now;
      const expiresAt = calculateExpiryUnix(TRIAL_DURATION_DAYS, issuedAt);
      insertSubscriptionRecord({
        schoolId,
        country,
        adminEmail: schoolEmail,
        adminName: schoolName,
        planKind: 'trial',
        status: 'active',
        activationCode: TRIAL_ACTIVATION_CODE,
        paymentMethod: 'trial',
        paymentChannel: 'trial',
        durationDays: TRIAL_DURATION_DAYS,
        onlineFeaturesEnabled: true,
        internalUid,
        machineHash,
        metadata: {
          app: String(req.body?.app || '').trim() || 'oasis-ems',
          version: String(req.body?.version || '').trim() || 'desktop',
        },
        activatedAt: unixToIso(issuedAt),
        expiresAt: unixToIso(expiresAt),
      });

      return {
        issuer: 'oasis-cloud-trial',
        code: TRIAL_ACTIVATION_CODE,
        label: 'Free Trial',
        school_id: schoolId,
        duration_days: TRIAL_DURATION_DAYS,
        issued_at: issuedAt,
        expires_at: expiresAt,
      };
    }, { allowCreate: true });

    return res.json(result);
  } catch (error) {
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to activate free trial.',
    });
  }
});

router.post('/manual/activate', async (req, res) => {
  try {
    const activationKey = String(req.body?.activation_key || '').trim();
    const machineHash = String(req.body?.machine_hash || '').trim();
    if (!activationKey) {
      return res.status(400).json({ error: 'activation_key is required.' });
    }
    if (!machineHash) {
      return res.status(400).json({ error: 'machine_hash is required.' });
    }

    const schoolId = normalizeSchoolId(req.body?.school_id);
    const country = normalizeSubscriptionCountry(req.body?.country);
    const schoolName = String(req.body?.school_name || '').trim();
    const schoolEmail = String(req.body?.school_email || '').trim().toLowerCase();
    assertLegacyLicenseServerConfigured();
    const activation = await postJson(`${LICENSE_SERVER_URL}/activate`, {
      machine_hash: machineHash,
      activation_key: activationKey,
      app: String(req.body?.app || '').trim() || 'oasis-ems',
      version: String(req.body?.version || '').trim() || 'desktop',
      school_id: schoolId || undefined,
    });

    if (!schoolId) {
      return res.json({
        ...activation,
        activation_server_url: LICENSE_SERVER_URL,
        plan_kind: 'manual_offline',
        online_features_enabled: false,
      });
    }

    const result = await runWithSchoolContext(schoolId, async () => {
      syncSchoolInfo({ schoolId, country, schoolName, schoolEmail });

      insertSubscriptionRecord({
        schoolId,
        country,
        adminEmail: schoolEmail,
        adminName: schoolName,
        planKind: 'manual_offline',
        status: 'active',
        activationCode: String(activation.code || activationKey).trim(),
        paymentMethod: 'activation_code',
        paymentChannel: 'manual',
        durationDays: Number(activation.duration_days || 0),
        onlineFeaturesEnabled: false,
        machineHash,
        metadata: {
          app: String(req.body?.app || '').trim() || 'oasis-ems',
          version: String(req.body?.version || '').trim() || 'desktop',
          activation_server_url: LICENSE_SERVER_URL,
        },
        activatedAt: unixToIso(activation.issued_at),
        expiresAt: unixToIso(activation.expires_at),
      });

      return {
        ...activation,
        activation_server_url: LICENSE_SERVER_URL,
        plan_kind: 'manual_offline',
        online_features_enabled: false,
      };
    }, { allowCreate: true });

    return res.json(result);
  } catch (error) {
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to activate manual subscription.',
    });
  }
});

router.post('/digital/initialize', async (req, res) => {
  const traceId = crypto.randomUUID().slice(0, 8);
  try {
    const schoolId = normalizeSchoolId(req.body?.school_id);
    if (!schoolId) {
      return res.status(400).json({ error: 'school_id is required.' });
    }

    const country = normalizeSubscriptionCountry(req.body?.country);
    const internalUid = String(req.body?.internal_uid || '').trim();
    const plan = getDigitalSubscriptionPlan(country);
    const paymentMethod = String(req.body?.payment_method || '').trim().toLowerCase();
    const methodMeta = getDigitalMethodMeta(country, paymentMethod);
    const baseLogContext = {
      trace_id: traceId,
      route: 'digital.initialize',
      school_id: schoolId,
      country,
      payment_method: paymentMethod,
      payment_channel: methodMeta?.channel || null,
      internal_uid: internalUid || null,
    };
    logPaymentEvent('digital.initialize.request_received', {
      ...baseLogContext,
      request_body: req.body || {},
    });

    if (!isDigitalMethodAllowed(country, paymentMethod) || !methodMeta) {
      return res.status(400).json({ error: 'Unsupported payment method for this country.' });
    }

    const adminEmail = String(req.body?.email || '').trim().toLowerCase();
    const adminName = String(req.body?.full_name || '').trim();
    const schoolName = String(req.body?.school_name || '').trim();
    const schoolEmail = String(req.body?.school_email || '').trim().toLowerCase();
    if (!adminEmail || !adminName) {
      return res.status(400).json({ error: 'email and full_name are required.' });
    }

    const result = await runWithSchoolContext(schoolId, async () => {
      syncSchoolInfo({ schoolId, country, schoolName, schoolEmail });

      const latestLedgerRecord = findLatestDigitalLedgerRecordBySchool(schoolId);
      logPaymentEvent('digital.initialize.latest_ledger_record', {
        ...baseLogContext,
        latest_record: latestLedgerRecord
          ? {
              id: latestLedgerRecord.id,
              status: latestLedgerRecord.status,
              charge_id: latestLedgerRecord.charge_id || null,
              created_at: latestLedgerRecord.created_at || null,
              updated_at: latestLedgerRecord.updated_at || null,
            }
          : null,
      });
      if (latestLedgerRecord?.status === 'pending_activation') {
        throw createHttpError(
          'A payment for this School ID has already been verified. Use the activation code sent to your email to finish setup.',
          409,
          {
            charge_id: latestLedgerRecord.charge_id || null,
            pending_expires_at: null,
            verification_window_minutes: PENDING_VERIFICATION_WINDOW_MINUTES,
          }
        );
      }
      if (latestLedgerRecord?.status === 'pending') {
        const pendingExpiresAt = getPendingVerificationDeadline(latestLedgerRecord);
        if (pendingExpiresAt > Date.now()) {
          throw createHttpError(
            `A payment request for this School ID is already pending verification until ${new Date(pendingExpiresAt).toLocaleString()}. Complete payment and verify it before starting another request.`,
            409,
            {
              charge_id: latestLedgerRecord.charge_id || null,
              pending_expires_at: timestampToIso(pendingExpiresAt),
              verification_window_minutes: PENDING_VERIFICATION_WINDOW_MINUTES,
            }
          );
        }
        markLedgerRecordFailed(latestLedgerRecord, 'verification_window_expired');
      }

      const chargeId = `sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      // Temporary test override: charge MWK 50 in PayChangu for Malawi subscriptions.
      const chargeAmount = plan.currency === 'MWK' ? MALAWI_TEST_PAYCHANGU_AMOUNT : plan.amount;
      const pendingExpiresAt = Date.now() + PENDING_VERIFICATION_WINDOW_MS;
      let providerResponse;
      const paymentLogContext = {
        ...baseLogContext,
        charge_id: chargeId,
        amount: chargeAmount,
        currency: plan.currency,
        duration_days: plan.durationDays,
      };

      logPaymentEvent('digital.initialize.preparing_provider_request', {
        ...paymentLogContext,
        pending_expires_at: timestampToIso(pendingExpiresAt),
      });

      if (methodMeta.channel === 'mobile_money') {
        const phoneNumber = sanitizePhoneNumberForProvider(req.body?.phone_number);
        if (!phoneNumber) {
          throw new Error('phone_number is required for mobile money payments.');
        }
        const { firstName, lastName } = splitFullName(adminName);
        const operatorRefId = await resolveMobileMoneyOperatorRefId(paymentMethod, paymentLogContext);
        providerResponse = await paychanguRequest('/mobile-money/payments/initialize', {
          method: 'POST',
          body: {
            mobile_money_operator_ref_id: operatorRefId,
            mobile: phoneNumber,
            email: adminEmail,
            first_name: firstName || 'Oasis',
            last_name: lastName || 'EMS',
            amount: chargeAmount,
            charge_id: chargeId,
          },
          logContext: paymentLogContext,
        });
      } else {
        const requiredFields = ['card_number', 'cvv', 'expiry_month', 'expiry_year'];
        const missing = requiredFields.filter((field) => !String(req.body?.[field] || '').trim());
        if (missing.length) {
          throw new Error(`Missing fields: ${missing.join(', ')}`);
        }
        providerResponse = await paychanguRequest('/charge-card/payments', {
          method: 'POST',
          body: {
            card_number: String(req.body?.card_number || '').trim(),
            cvv: String(req.body?.cvv || '').trim(),
            expiry_month: String(req.body?.expiry_month || '').trim(),
            expiry_year: String(req.body?.expiry_year || '').trim(),
            amount: chargeAmount,
            currency: plan.currency,
            email: adminEmail,
            charge_id: chargeId,
          },
          logContext: paymentLogContext,
        });
      }

      logPaymentEvent('digital.initialize.provider_response_received', {
        ...paymentLogContext,
        provider_response: providerResponse,
      });

      const providerMode = String(providerResponse?.data?.mode || providerResponse?.mode || '').trim().toLowerCase() || null;
      const providerStatus = String(providerResponse?.data?.status || providerResponse?.status || '').trim().toLowerCase() || null;
      const providerMessage = String(providerResponse?.message || '').trim() || null;
      const sandboxWarning = methodMeta.channel === 'mobile_money'
        ? buildSandboxMobileMoneyWarning(paymentMethod, req.body?.phone_number, providerMode)
        : null;

      if (sandboxWarning) {
        logPaymentEvent('digital.initialize.sandbox_warning', {
          ...paymentLogContext,
          provider_mode: providerMode,
          warning: sandboxWarning,
        });
      }

      const ledgerId = insertSubscriptionRecord({
        schoolId,
        country,
        adminEmail,
        adminName,
        planKind: 'digital_online',
        status: 'pending',
        chargeId,
        paymentMethod,
        paymentChannel: methodMeta.channel,
        amount: chargeAmount,
        currency: plan.currency,
        durationDays: plan.durationDays,
        onlineFeaturesEnabled: true,
        internalUid,
        metadata: {
          provider: providerResponse,
          provider_mode: providerMode,
          provider_status: providerStatus,
          provider_message: providerMessage,
          sandbox_warning: sandboxWarning,
          pending_expires_at: timestampToIso(pendingExpiresAt),
          verification_window_minutes: PENDING_VERIFICATION_WINDOW_MINUTES,
        },
      });

      logPaymentEvent('digital.initialize.ledger_record_created', {
        ...paymentLogContext,
        ledger_id: ledgerId,
        pending_expires_at: timestampToIso(pendingExpiresAt),
      });

      return {
        status: 'pending',
        charge_id: chargeId,
        payment_method: paymentMethod,
        payment_channel: methodMeta.channel,
        amount: chargeAmount,
        currency: plan.currency,
        duration_days: plan.durationDays,
        pending_expires_at: timestampToIso(pendingExpiresAt),
        verification_window_minutes: PENDING_VERIFICATION_WINDOW_MINUTES,
        message: `Payment request created. Complete payment and verify it within ${PENDING_VERIFICATION_WINDOW_MINUTES} minutes.`,
        provider_mode: providerMode,
        provider_status: providerStatus,
        provider_message: providerMessage,
        warning: sandboxWarning,
      };
    }, { allowCreate: true });

    logPaymentEvent('digital.initialize.completed', {
      trace_id: traceId,
      route: 'digital.initialize',
      response: result,
    });
    return res.json(result);
  } catch (error) {
    logPaymentError('digital.initialize.failed', error, {
      trace_id: traceId,
      route: 'digital.initialize',
      request_body: req.body || {},
    });
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to initialize digital payment.',
    });
  }
});

router.post('/digital/verify-payment', async (req, res) => {
  const traceId = crypto.randomUUID().slice(0, 8);
  try {
    const schoolId = normalizeSchoolId(req.body?.school_id);
    if (!schoolId) {
      return res.status(400).json({ error: 'school_id is required.' });
    }

    const baseLogContext = {
      trace_id: traceId,
      route: 'digital.verify_payment',
      school_id: schoolId,
      requested_charge_id: String(req.body?.charge_id || '').trim() || null,
    };
    logPaymentEvent('digital.verify.request_received', {
      ...baseLogContext,
      request_body: req.body || {},
    });

    const result = await runWithSchoolContext(schoolId, async () => {
      const record = findLatestDigitalLedgerRecordBySchool(schoolId);
      if (!record) {
        throw createHttpError('No pending payment request was found for this School ID.', 404);
      }

      const paymentLogContext = {
        ...baseLogContext,
        charge_id: String(record.charge_id || '').trim() || null,
        payment_method: record.payment_method || null,
        payment_channel: record.payment_channel || null,
        ledger_id: record.id,
        ledger_status: record.status,
      };
      logPaymentEvent('digital.verify.ledger_record_loaded', {
        ...paymentLogContext,
        record_snapshot: {
          status: record.status,
          created_at: record.created_at || null,
          updated_at: record.updated_at || null,
          pending_expires_at: timestampToIso(getPendingVerificationDeadline(record)),
        },
      });

      if (record.status === 'pending_activation') {
        return {
          status: 'pending_activation',
          charge_id: record.charge_id || null,
          email_sent: readEmailSentFromMetadata(record),
          email_error: readEmailErrorFromMetadata(record),
          pending_expires_at: null,
        };
      }
      if (record.status !== 'pending') {
        throw createHttpError('No payment request is awaiting verification for this School ID.', 409);
      }

      const pendingExpiresAt = getPendingVerificationDeadline(record);
      if (!pendingExpiresAt || pendingExpiresAt <= Date.now()) {
        markLedgerRecordFailed(record, 'verification_window_expired');
        throw createHttpError(
          `This payment request expired after ${PENDING_VERIFICATION_WINDOW_MINUTES} minutes. Start a new payment request.`,
          410,
          {
            charge_id: record.charge_id || null,
            pending_expires_at: timestampToIso(pendingExpiresAt),
            verification_window_minutes: PENDING_VERIFICATION_WINDOW_MINUTES,
          }
        );
      }

      const chargeId = String(record.charge_id || '').trim();
      const verification = record.payment_channel === 'card'
        ? await paychanguRequest(`/charge-card/verify/${chargeId}`, {
            logContext: paymentLogContext,
          })
        : await paychanguRequest(`/mobile-money/payments/${chargeId}/verify`, {
            logContext: paymentLogContext,
          });

      logPaymentEvent('digital.verify.provider_verification_received', {
        ...paymentLogContext,
        verification_payload: verification,
        payment_successful: isPaychanguPaymentSuccessful(verification),
      });

      if (!isPaychanguPaymentSuccessful(verification)) {
        throw createHttpError('Payment has not been confirmed yet.', 409);
      }

      const activationCode = String(record.activation_code || '').trim() || generateUniqueDigitalActivationCode();

      const metadata = {
        ...parseMetadata(record.metadata),
        verification,
      };

      let emailResult = { ok: false, error: 'SMTP is not configured on the cloud server.' };
      try {
        emailResult = await sendActivationEmail({
          email: String(record.admin_email || '').trim(),
          code: activationCode,
          durationDays: Number(record.duration_days || DIGITAL_SUBSCRIPTION_DURATION_DAYS),
          label: 'Digital Subscription',
          schoolId,
        });
      } catch (error) {
        logPaymentError('payment.email.failed', error, {
          ...paymentLogContext,
          school_id: schoolId,
          email: String(record.admin_email || '').trim(),
          activation_code: activationCode,
        });
        emailResult = { ok: false, error: error.message || 'Failed to send activation email.' };
      }

      metadata.email_result = emailResult;

      db.prepare(`
        UPDATE subscription_records
        SET status = 'pending_activation',
            activation_code = ?,
            metadata = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        activationCode,
        JSON.stringify(metadata),
        record.id
      );

      logPaymentEvent('digital.verify.ledger_record_updated', {
        ...paymentLogContext,
        next_status: 'pending_activation',
        activation_code: activationCode,
        email_result: emailResult,
      });

      return {
        status: 'pending_activation',
        charge_id: chargeId,
        email_sent: emailResult.ok,
        email_error: emailResult.ok ? null : emailResult.error,
        pending_expires_at: null,
      };
    }, { allowCreate: true });

    logPaymentEvent('digital.verify.completed', {
      trace_id: traceId,
      route: 'digital.verify_payment',
      response: result,
    });
    return res.json(result);
  } catch (error) {
    logPaymentError('digital.verify.failed', error, {
      trace_id: traceId,
      route: 'digital.verify_payment',
      request_body: req.body || {},
    });
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to verify payment.',
    });
  }
});

router.post('/digital/activate', async (req, res) => {
  const traceId = crypto.randomUUID().slice(0, 8);
  try {
    const schoolId = normalizeSchoolId(req.body?.school_id);
    const activationKey = String(req.body?.activation_key || '').trim();
    const internalUid = String(req.body?.internal_uid || '').trim();
    const machineHash = String(req.body?.machine_hash || '').trim();
    if (!schoolId || !activationKey || !machineHash) {
      return res.status(400).json({ error: 'school_id, activation_key, and machine_hash are required.' });
    }

    const baseLogContext = {
      trace_id: traceId,
      route: 'digital.activate',
      school_id: schoolId,
      activation_key: activationKey,
      internal_uid: internalUid || null,
      machine_hash: machineHash,
    };
    logPaymentEvent('digital.activate.request_received', {
      ...baseLogContext,
      request_body: req.body || {},
    });

    const result = await runWithSchoolContext(schoolId, async () => {
      const record = db.prepare(`
        SELECT *
        FROM subscription_records
        WHERE activation_code = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(activationKey);

      if (!record) {
        throw createHttpError('Invalid activation code.', 404);
      }

      const paymentLogContext = {
        ...baseLogContext,
        charge_id: String(record.charge_id || '').trim() || null,
        payment_method: record.payment_method || null,
        payment_channel: record.payment_channel || null,
        ledger_id: record.id,
        ledger_status: record.status,
      };
      logPaymentEvent('digital.activate.ledger_record_loaded', {
        ...paymentLogContext,
        record_snapshot: {
          status: record.status,
          activated_at: record.activated_at || null,
          expires_at: record.expires_at || null,
        },
      });

      const existingMachineHash = String(record.machine_hash || '').trim();
      if (record.status === 'active') {
        if (existingMachineHash && existingMachineHash !== machineHash) {
          throw createHttpError('Activation code has already been used on another device.', 409);
        }
        const activation = buildDigitalActivationPayload(record, schoolId);
        logPaymentEvent('digital.activate.already_active', {
          ...paymentLogContext,
          activation_payload: activation,
        });
        return {
          ...activation,
          charge_id: record.charge_id || null,
          payment_method: record.payment_method || null,
          payment_channel: record.payment_channel || null,
          amount: Number(record.amount || 0) || null,
          currency: record.currency || null,
          email: record.admin_email || null,
          full_name: record.admin_name || null,
        };
      }

      if (record.status !== 'pending_activation') {
        throw createHttpError('Payment verification is required before activation.', 409);
      }

      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresAt = calculateExpiryUnix(
        Number(record.duration_days || DIGITAL_SUBSCRIPTION_DURATION_DAYS),
        issuedAt
      );
      const activation = {
        ...buildDigitalActivationPayload({
          ...record,
          activated_at: unixToIso(issuedAt),
          expires_at: unixToIso(expiresAt),
        }, schoolId),
      };
      const metadata = {
        ...parseMetadata(record.metadata),
        activation,
      };

      db.prepare(`
        UPDATE subscription_records
        SET status = 'active',
            internal_uid = COALESCE(?, internal_uid),
            machine_hash = ?,
            activated_at = ?,
            expires_at = ?,
            metadata = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        internalUid || null,
        machineHash,
        unixToIso(issuedAt),
        unixToIso(expiresAt),
        JSON.stringify(metadata),
        record.id
      );

      const latest = db.prepare('SELECT * FROM subscription_records WHERE id = ?').get(record.id);
      logPaymentEvent('digital.activate.ledger_record_updated', {
        ...paymentLogContext,
        next_status: 'active',
        activation_payload: activation,
      });

      return {
        ...activation,
        charge_id: latest?.charge_id || null,
        payment_method: latest?.payment_method || null,
        payment_channel: latest?.payment_channel || null,
        amount: Number(latest?.amount || 0) || null,
        currency: latest?.currency || null,
        email: latest?.admin_email || null,
        full_name: latest?.admin_name || null,
      };
    }, { allowCreate: true });

    logPaymentEvent('digital.activate.completed', {
      trace_id: traceId,
      route: 'digital.activate',
      response: result,
    });
    return res.json(result);
  } catch (error) {
    logPaymentError('digital.activate.failed', error, {
      trace_id: traceId,
      route: 'digital.activate',
      request_body: req.body || {},
    });
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to activate digital subscription.',
    });
  }
});

export default router;
