/** Ensure API routes return JSON (helps cPanel/Apache mis-detection as downloadable text). */
export function jsonApiHeaders(req, res, next) {
  const path = req.path || '';
  if (
    path === '/' ||
    path === '/health' ||
    path.startsWith('/api/') ||
    path.endsWith('.json')
  ) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  next();
}

export function sendJson(res, statusCode, payload) {
  res.status(statusCode);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(JSON.stringify(payload, null, 2));
}
