function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export async function probeHttpEndpoint(url, { timeoutMs = 8000, accept = 'application/json' } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: accept,
      },
      signal: controller.signal,
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const text = await response.text();
    let json = null;
    let parseError = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      parseError = error?.message || 'Response was not valid JSON.';
    }

    return {
      ok: response.ok && Boolean(json) && !parseError,
      url,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      content_type: contentType || null,
      response_preview: text.slice(0, 280),
      json,
      parse_error: parseError,
      looks_like_file_download:
        contentType.includes('text/plain') ||
        contentType.includes('application/octet-stream') ||
        contentType.includes('application/force-download'),
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: 0,
      duration_ms: Date.now() - startedAt,
      error: error?.message || 'Request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCloudHealth(baseUrl, { timeoutMs = 8000 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return {
      ok: false,
      error: 'Cloud server URL is empty.',
      attempts: [],
    };
  }

  const paths = ['/api/health', '/health', '/api/health.json'];
  const attempts = [];
  for (const path of paths) {
    const result = await probeHttpEndpoint(`${normalized}${path}`, { timeoutMs });
    attempts.push(result);
    if (result.ok) {
      return {
        ok: true,
        url: normalized,
        path,
        attempts,
        health: result.json,
      };
    }
  }

  const rootJson = await probeHttpEndpoint(normalized, { timeoutMs, accept: 'application/json' });
  attempts.push(rootJson);
  if (rootJson.ok && rootJson.json?.service === 'oasis-ems-cloud') {
    return {
      ok: true,
      url: normalized,
      path: '/',
      attempts,
      health: rootJson.json,
      hint: 'Health reached via GET / with Accept: application/json. Add Passenger fallback rewrites in .htaccess so /api/* routes reach Express.',
    };
  }

  return {
    ok: false,
    url: normalized,
    attempts,
    hint:
      'If the browser downloads a .txt file, Passenger is probably not exporting the Express app. Redeploy with the updated passenger-boot.cjs and open /api/health with Accept: application/json.',
  };
}
