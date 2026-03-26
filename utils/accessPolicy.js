import db from '../db/database.js';

const LICENSE_SERVER_URL = String(
  process.env.OASIS_LICENSE_SERVER_URL || 'https://oasis-ems-official-license-server-production.up.railway.app'
).trim().replace(/\/+$/, '');
const STATUS_CACHE_TTL_MS = Number(process.env.OASIS_LICENSE_STATUS_CACHE_MS || 5 * 60 * 1000);
const schoolStatusCache = new Map();

function createPolicyError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

export function normalizeSchoolId(value) {
  return String(value || '').trim().toUpperCase();
}

export function getConfiguredSchoolId() {
  const row = db.prepare('SELECT school_id FROM school_info WHERE id = 1').get();
  return normalizeSchoolId(row?.school_id);
}

function hasActiveAdminAccount() {
  const row = db.prepare(`
    SELECT 1
    FROM users
    WHERE role = 'admin' AND is_active = 1
    LIMIT 1
  `).get();
  return Boolean(row);
}

function getRecordedSchoolActivationStatus(schoolId) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (!normalizedSchoolId) return null;

  db.prepare(`
    UPDATE subscription_records
    SET status = 'expired',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at <= CURRENT_TIMESTAMP
  `).run();

  const row = db.prepare(`
    SELECT plan_kind, activated_at, expires_at
    FROM subscription_records
    WHERE status = 'active'
      AND online_features_enabled = 1
      AND school_id = ?
    ORDER BY expires_at DESC, created_at DESC
    LIMIT 1
  `).get(normalizedSchoolId);

  if (!row) return null;

  const expiresAt = Math.floor(new Date(row.expires_at || 0).getTime() / 1000);
  return {
    active: expiresAt > Math.floor(Date.now() / 1000),
    schoolId: normalizedSchoolId,
    expiresAt,
    activatedAt: row.activated_at || null,
    label: row.plan_kind === 'trial' ? 'Free Trial' : 'Digital Subscription',
  };
}

async function fetchSchoolActivationStatus(schoolId) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (!normalizedSchoolId) {
    throw createPolicyError('School ID is missing for this cloud school.', 403);
  }

  const recorded = getRecordedSchoolActivationStatus(normalizedSchoolId);
  if (recorded) {
    schoolStatusCache.set(normalizedSchoolId, {
      value: recorded,
      expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
    });
    return recorded;
  }

  const cached = schoolStatusCache.get(normalizedSchoolId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (!LICENSE_SERVER_URL) {
    throw createPolicyError('License server is not configured for teacher access validation.', 503);
  }

  let response;
  try {
    response = await fetch(`${LICENSE_SERVER_URL}/schools/${encodeURIComponent(normalizedSchoolId)}/status`);
  } catch (_error) {
    throw createPolicyError('Unable to verify school subscription right now.', 503);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createPolicyError(payload?.error || 'Unable to verify school subscription right now.', 503);
  }

  const result = {
    active: payload?.active === true,
    schoolId: normalizeSchoolId(payload?.school_id || normalizedSchoolId),
    expiresAt: Number(payload?.expires_at || 0),
    activatedAt: payload?.activated_at || null,
    label: payload?.label || null,
  };

  schoolStatusCache.set(normalizedSchoolId, {
    value: result,
    expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
  });

  return result;
}

export function assertSchoolIdMatchesCurrent(requestedSchoolId) {
  const normalizedRequested = normalizeSchoolId(requestedSchoolId);
  if (!normalizedRequested) {
    throw createPolicyError('School ID is required for online login.', 400);
  }

  const configuredSchoolId = getConfiguredSchoolId();
  if (!configuredSchoolId || normalizedRequested !== configuredSchoolId) {
    throw createPolicyError('School ID does not match this school.', 403);
  }

  return configuredSchoolId;
}

export async function assertTeacherAccessPolicy(user) {
  if (!user || user.role !== 'teacher') {
    return { active: true, schoolId: getConfiguredSchoolId() };
  }

  if (!hasActiveAdminAccount()) {
    throw createPolicyError('Teacher access is disabled because the admin account is inactive.', 403);
  }

  const schoolId = getConfiguredSchoolId();
  const activation = await fetchSchoolActivationStatus(schoolId);
  if (!activation.active) {
    throw createPolicyError('Teacher access is disabled because this school subscription is inactive or expired.', 403);
  }

  return activation;
}
