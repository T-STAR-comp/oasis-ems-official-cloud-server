import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DISCOVERY_SERVER_URL = 'https://ems-license-server.vercel.app';

function ensureConfigRoot() {
  const configRoot = process.env.OASIS_CONFIG_DIR
    ? path.resolve(process.env.OASIS_CONFIG_DIR)
    : path.resolve(process.cwd(), '.oasis-config');
  if (!fs.existsSync(configRoot)) {
    fs.mkdirSync(configRoot, { recursive: true });
  }
  return configRoot;
}

function getCachePath() {
  return path.join(ensureConfigRoot(), 'cloud-server-url.json');
}

function normalizeUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

export function getDiscoveryServerUrl() {
  return normalizeUrl(
    process.env.OASIS_PUBLIC_URL_SERVER ||
    process.env.OASIS_LICENSE_SERVER_URL ||
    process.env.OASIS_LEGACY_LICENSE_SERVER_URL ||
    DEFAULT_DISCOVERY_SERVER_URL
  );
}

export function getCloudServerUrlOverride() {
  return normalizeUrl(process.env.OASIS_CLOUD_SERVER_URL || '');
}

export function readCachedCloudServerUrl() {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) return '';

  try {
    const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return normalizeUrl(payload?.url);
  } catch (_error) {
    return '';
  }
}

export function writeCachedCloudServerUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    clearCachedCloudServerUrl();
    return '';
  }

  fs.writeFileSync(getCachePath(), JSON.stringify({
    url: normalized,
    updated_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  return normalized;
}

export function clearCachedCloudServerUrl() {
  const cachePath = getCachePath();
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }
}

export async function fetchCloudServerUrlFromLicenseServer({ timeoutMs = 6000 } = {}) {
  const discoveryServerUrl = getDiscoveryServerUrl();
  if (!discoveryServerUrl) {
    throw new Error('License server URL is not configured for cloud URL discovery.');
  }

  const response = await fetch(`${discoveryServerUrl}/public-url`, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Failed to fetch cloud server URL (${response.status}).`);
  }

  const resolvedUrl = normalizeUrl(payload?.url);
  if (!resolvedUrl) {
    throw new Error('The license server returned an empty cloud server URL.');
  }

  writeCachedCloudServerUrl(resolvedUrl);
  return {
    url: resolvedUrl,
    source: 'license_server',
    discoveryServerUrl,
  };
}

export async function resolveCloudServerUrl({ refresh = false, timeoutMs = 6000 } = {}) {
  const envOverride = getCloudServerUrlOverride();
  if (envOverride) {
    if (!refresh) {
      writeCachedCloudServerUrl(envOverride);
    }
    return {
      url: envOverride,
      source: 'env_override',
      discoveryServerUrl: getDiscoveryServerUrl(),
    };
  }

  const cachedUrl = refresh ? '' : readCachedCloudServerUrl();
  if (cachedUrl) {
    return {
      url: cachedUrl,
      source: 'cache',
      discoveryServerUrl: getDiscoveryServerUrl(),
    };
  }

  return fetchCloudServerUrlFromLicenseServer({ timeoutMs });
}
