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

function normalizeSchoolId(value) {
  return String(value || '').trim().toUpperCase();
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}

function unixToIso(value) {
  const numeric = Number(value || 0);
  if (!numeric) return null;
  return new Date(numeric * 1000).toISOString();
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

async function paychanguRequest(endpoint, { method = 'GET', body } = {}) {
  assertPaychanguConfigured();
  const url = `${PAYCHANGU_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${PAYCHANGU_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
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

  await transporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject,
    text: lines.join('\n'),
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

async function resolveMobileMoneyOperatorRefId(methodCode) {
  const payload = await paychanguRequest('/mobile-money');
  const operators = extractOperatorEntries(payload);
  const needle = String(methodCode || '').trim().toLowerCase();
  const match = operators.find((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
  const refId =
    match?.mobile_money_operator_ref_id ||
    match?.operator_ref_id ||
    match?.ref_id ||
    match?.id ||
    null;
  if (!refId) {
    throw new Error(`Could not find a PayChangu operator for ${needle}.`);
  }
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

      const chargeId = `sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      let providerResponse;

      if (methodMeta.channel === 'mobile_money') {
        const phoneNumber = String(req.body?.phone_number || '').trim();
        if (!phoneNumber) {
          throw new Error('phone_number is required for mobile money payments.');
        }
        const { firstName, lastName } = splitFullName(adminName);
        const operatorRefId = await resolveMobileMoneyOperatorRefId(paymentMethod);
        providerResponse = await paychanguRequest('/mobile-money/payments/initialize', {
          method: 'POST',
          body: {
            mobile_money_operator_ref_id: operatorRefId,
            mobile: phoneNumber,
            email: adminEmail,
            first_name: firstName || 'Oasis',
            last_name: lastName || 'EMS',
            amount: plan.amount,
            charge_id: chargeId,
          },
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
            amount: plan.amount,
            currency: plan.currency,
            email: adminEmail,
            charge_id: chargeId,
          },
        });
      }

      insertSubscriptionRecord({
        schoolId,
        country,
        adminEmail,
        adminName,
        planKind: 'digital_online',
        status: 'pending',
        chargeId,
        paymentMethod,
        paymentChannel: methodMeta.channel,
        amount: plan.amount,
        currency: plan.currency,
        durationDays: plan.durationDays,
        onlineFeaturesEnabled: true,
        internalUid,
        metadata: {
          provider: providerResponse,
        },
      });

      return {
        status: 'pending',
        charge_id: chargeId,
        payment_method: paymentMethod,
        payment_channel: methodMeta.channel,
        amount: plan.amount,
        currency: plan.currency,
        duration_days: plan.durationDays,
      };
    }, { allowCreate: true });

    return res.json(result);
  } catch (error) {
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to initialize digital payment.',
    });
  }
});

router.post('/digital/verify-payment', async (req, res) => {
  try {
    const schoolId = normalizeSchoolId(req.body?.school_id);
    const chargeId = String(req.body?.charge_id || '').trim();
    if (!schoolId || !chargeId) {
      return res.status(400).json({ error: 'school_id and charge_id are required.' });
    }

    const result = await runWithSchoolContext(schoolId, async () => {
      const record = db.prepare(`
        SELECT *
        FROM subscription_records
        WHERE charge_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(chargeId);
      if (!record) {
        throw createHttpError('Subscription payment was not found.', 404);
      }
      if (record.status === 'active') {
        throw createHttpError('This digital subscription has already been activated.', 409);
      }

      const verification = record.payment_channel === 'card'
        ? await paychanguRequest(`/charge-card/verify/${chargeId}`)
        : await paychanguRequest(`/mobile-money/payments/${chargeId}/verify`);

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
        emailResult = { ok: false, error: error.message || 'Failed to send activation email.' };
      }

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

      return {
        status: 'pending_activation',
        charge_id: chargeId,
        email_sent: emailResult.ok,
        email_error: emailResult.ok ? null : emailResult.error,
      };
    }, { allowCreate: true });

    return res.json(result);
  } catch (error) {
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to verify payment.',
    });
  }
});

router.post('/digital/activate', async (req, res) => {
  try {
    const schoolId = normalizeSchoolId(req.body?.school_id);
    const activationKey = String(req.body?.activation_key || '').trim();
    const internalUid = String(req.body?.internal_uid || '').trim();
    const machineHash = String(req.body?.machine_hash || '').trim();
    if (!schoolId || !activationKey || !machineHash) {
      return res.status(400).json({ error: 'school_id, activation_key, and machine_hash are required.' });
    }

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

      const existingMachineHash = String(record.machine_hash || '').trim();
      if (record.status === 'active') {
        if (existingMachineHash && existingMachineHash !== machineHash) {
          throw createHttpError('Activation code has already been used on another device.', 409);
        }
        const activation = buildDigitalActivationPayload(record, schoolId);
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

    return res.json(result);
  } catch (error) {
    return res.status(Number(error?.statusCode || error?.status || 500)).json({
      error: error.message || 'Failed to activate digital subscription.',
    });
  }
});

export default router;
