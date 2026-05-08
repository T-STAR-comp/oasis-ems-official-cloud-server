import express from 'express';
import crypto from 'node:crypto';
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
  process.env.OASIS_LICENSE_SERVER_URL || 'https://oasis-ems-official-license-server-production.up.railway.app'
).trim().replace(/\/+$/, '');

function normalizeSchoolId(value) {
  return String(value || '').trim().toUpperCase();
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

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
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
  const payload = await fetchJson(`${LICENSE_SERVER_URL}/payments/mobile-money/operators`);
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
        throw new Error('Free trial has already been used for this school.');
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
    return res.status(500).json({ error: error.message || 'Failed to activate free trial.' });
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
    return res.status(500).json({ error: error.message || 'Failed to activate manual subscription.' });
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
        providerResponse = await postJson(`${LICENSE_SERVER_URL}/payments/mobile-money/initialize`, {
          mobile_money_operator_ref_id: operatorRefId,
          mobile: phoneNumber,
          email: adminEmail,
          first_name: firstName || 'Oasis',
          last_name: lastName || 'EMS',
          amount: plan.amount,
          charge_id: chargeId,
        });
      } else {
        const requiredFields = ['card_number', 'cvv', 'expiry_month', 'expiry_year'];
        const missing = requiredFields.filter((field) => !String(req.body?.[field] || '').trim());
        if (missing.length) {
          throw new Error(`Missing fields: ${missing.join(', ')}`);
        }
        providerResponse = await postJson(`${LICENSE_SERVER_URL}/payments/card/charge`, {
          card_number: String(req.body?.card_number || '').trim(),
          cvv: String(req.body?.cvv || '').trim(),
          expiry_month: String(req.body?.expiry_month || '').trim(),
          expiry_year: String(req.body?.expiry_year || '').trim(),
          amount: plan.amount,
          currency: plan.currency,
          email: adminEmail,
          charge_id: chargeId,
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
    return res.status(500).json({ error: error.message || 'Failed to initialize digital payment.' });
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
        throw new Error('Subscription payment was not found.');
      }

      const verification = await postJson(`${LICENSE_SERVER_URL}/payments/confirm`, {
        charge_id: chargeId,
        method: record.payment_channel === 'card' ? 'card' : 'mobile_money',
        email: record.admin_email,
        duration_days: record.duration_days || DIGITAL_SUBSCRIPTION_DURATION_DAYS,
        label: 'Digital Subscription',
        amount: record.amount || 0,
      });

      const metadata = {
        ...parseMetadata(record.metadata),
        verification,
      };

      db.prepare(`
        UPDATE subscription_records
        SET status = 'pending_activation',
            activation_code = ?,
            metadata = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        String(verification.activation_code || '').trim() || null,
        JSON.stringify(metadata),
        record.id
      );

      return {
        status: 'pending_activation',
        charge_id: chargeId,
        email_sent: Boolean(verification.email_sent),
        email_error: verification.email_error || null,
      };
    }, { allowCreate: true });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to verify payment.' });
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

    const activation = await postJson(`${LICENSE_SERVER_URL}/activate`, {
      machine_hash: machineHash,
      activation_key: activationKey,
      app: String(req.body?.app || '').trim() || 'oasis-ems',
      version: String(req.body?.version || '').trim() || 'desktop',
      school_id: schoolId,
    });

    const result = await runWithSchoolContext(schoolId, async () => {
      const record = db.prepare(`
        SELECT *
        FROM subscription_records
        WHERE activation_code = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(activationKey);

      if (record) {
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
          unixToIso(activation.issued_at),
          unixToIso(activation.expires_at),
          JSON.stringify(metadata),
          record.id
        );
      } else {
        insertSubscriptionRecord({
          schoolId,
          country: normalizeSubscriptionCountry(req.body?.country),
          adminEmail: '',
          adminName: '',
          planKind: 'digital_online',
          status: 'active',
          activationCode: activationKey,
          paymentMethod: 'digital',
          paymentChannel: 'digital',
          durationDays: Number(activation.duration_days || DIGITAL_SUBSCRIPTION_DURATION_DAYS),
          onlineFeaturesEnabled: true,
          internalUid,
          machineHash,
          activatedAt: unixToIso(activation.issued_at),
          expiresAt: unixToIso(activation.expires_at),
          metadata: { activation },
        });
      }

      const latest = record
        ? db.prepare('SELECT * FROM subscription_records WHERE id = ?').get(record.id)
        : db.prepare(`
            SELECT *
            FROM subscription_records
            WHERE activation_code = ?
            ORDER BY created_at DESC
            LIMIT 1
          `).get(activationKey);

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
    return res.status(500).json({ error: error.message || 'Failed to activate digital subscription.' });
  }
});

export default router;
