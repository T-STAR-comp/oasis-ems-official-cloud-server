import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  currency: 'MWK',
  plans: [],
  activation_codes: [],
};

let cachedConfig = null;
let cachedPath = null;
let cachedMtimeMs = 0;

function resolveCommerceConfigPath() {
  if (process.env.OASIS_COMMERCE_CONFIG) {
    return path.resolve(process.env.OASIS_COMMERCE_CONFIG);
  }

  const cwdCandidate = path.join(process.cwd(), 'config', 'commerce.json');
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const localCloudCandidate = path.resolve(moduleDir, '../config/commerce.json');
  if (fs.existsSync(localCloudCandidate)) {
    return localCloudCandidate;
  }

  const repoCloudCandidate = path.resolve(moduleDir, '../cloud-server/config/commerce.json');
  if (fs.existsSync(repoCloudCandidate)) {
    return repoCloudCandidate;
  }

  const sharedCandidate = path.join(moduleDir, 'commerce.config.json');
  if (fs.existsSync(sharedCandidate)) {
    return sharedCandidate;
  }

  return localCloudCandidate;
}

function normalizeActivationCode(entry, index) {
  const code = String(entry?.code || '').trim();
  if (!code) return null;

  const type = String(entry?.type || 'manual').trim().toLowerCase();
  const durationDays = Number(entry?.duration_days || entry?.durationDays || 365);
  const onlineFeatures = entry?.online_features ?? entry?.onlineFeatures;

  return {
    code,
    type: type === 'trial' ? 'trial' : 'manual',
    label: String(entry?.label || code).trim(),
    duration_days: Number.isFinite(durationDays) && durationDays > 0 ? durationDays : 365,
    online_features: onlineFeatures !== false && type !== 'manual',
  };
}

function normalizePlan(entry, index, currency) {
  const durationMonths = Number(entry?.duration_months ?? entry?.durationMonths ?? 0);
  const amount = Number(entry?.amount ?? entry?.price ?? entry?.price_kwacha ?? 0);
  if (!Number.isFinite(durationMonths) || durationMonths <= 0) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const accessMode = String(entry?.access_mode ?? entry?.accessMode ?? 'online').trim().toLowerCase();
  const planCurrency = String(entry?.currency || currency || 'MWK').trim().toUpperCase();

  return {
    id: String(entry?.id || `plan-${index + 1}`).trim().toLowerCase(),
    name: String(entry?.name || `Plan ${index + 1}`).trim(),
    duration_months: durationMonths,
    amount,
    currency: planCurrency,
    access_mode: accessMode === 'offline' ? 'offline' : 'online',
  };
}

export function loadCommerceConfig(forceReload = false) {
  const configPath = resolveCommerceConfigPath();
  const stat = fs.existsSync(configPath) ? fs.statSync(configPath) : null;
  const mtimeMs = stat?.mtimeMs || 0;

  if (!forceReload && cachedConfig && cachedPath === configPath && cachedMtimeMs === mtimeMs) {
    return cachedConfig;
  }

  if (!stat) {
    cachedConfig = { ...DEFAULT_CONFIG, config_path: configPath, source: 'default' };
    cachedPath = configPath;
    cachedMtimeMs = 0;
    return cachedConfig;
  }

  let parsed = DEFAULT_CONFIG;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_error) {
    parsed = DEFAULT_CONFIG;
  }

  const currency = String(parsed?.currency || 'MWK').trim().toUpperCase();
  const plans = (Array.isArray(parsed?.plans) ? parsed.plans : [])
    .map((entry, index) => normalizePlan(entry, index, currency))
    .filter(Boolean);
  const activation_codes = (Array.isArray(parsed?.activation_codes) ? parsed.activation_codes : [])
    .map((entry, index) => normalizeActivationCode(entry, index))
    .filter(Boolean);

  cachedConfig = {
    currency,
    plans,
    activation_codes,
    config_path: configPath,
    source: 'file',
  };
  cachedPath = configPath;
  cachedMtimeMs = mtimeMs;
  return cachedConfig;
}

export function getCommerceConfigPath() {
  return resolveCommerceConfigPath();
}

export function getConfiguredPlans() {
  return loadCommerceConfig().plans;
}

export function findActivationCode(code) {
  const normalized = String(code || '').trim();
  if (!normalized) return null;
  return loadCommerceConfig().activation_codes.find((entry) => entry.code === normalized) || null;
}

export function getTrialActivationCodes() {
  return loadCommerceConfig().activation_codes.filter((entry) => entry.type === 'trial');
}

export function getTrialActivationCode() {
  return getTrialActivationCodes()[0]?.code || 'OASIS-EMS-LIN-26-26';
}

export function getTrialDurationDays() {
  return getTrialActivationCodes()[0]?.duration_days || 365;
}

export function isTrialActivationCode(code) {
  const entry = findActivationCode(code);
  return Boolean(entry && entry.type === 'trial');
}

export function buildActivationPayloadFromCode(code) {
  const entry = findActivationCode(code);
  if (!entry) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const durationDays = entry.duration_days;
  const expiresAt = issuedAt + Math.max(1, durationDays) * 24 * 60 * 60;

  return {
    issuer: 'oasis-commerce-config',
    code: entry.code,
    label: entry.label,
    duration_days: durationDays,
    issued_at: issuedAt,
    expires_at: expiresAt,
    online_features_enabled: entry.online_features,
    plan_kind: entry.type === 'trial' ? 'trial' : 'manual_offline',
  };
}
