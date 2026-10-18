/**
 * Reject cross-site state-changing requests. Combined with JSON-only bodies,
 * this prevents another origin from triggering deployments through a browser.
 */
export function requireSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    res.status(403).json({ error: '非法的 Origin 请求头' });
    return;
  }
  const allowed = new Set(
    [req.get('host'), req.get('x-forwarded-host')]
      .filter(Boolean)
      .map((value) => value.split(',')[0].trim()),
  );
  if (allowed.has(originHost)) return next();
  res.status(403).json({ error: '拒绝了跨站请求' });
}
