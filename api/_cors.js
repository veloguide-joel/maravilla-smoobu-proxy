const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500"
]);

export function applyCors(req, res) {
  if (res.__corsWrapped) {
    return;
  }

  res.__corsWrapped = true;

  const origin = req.headers.origin;
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin);

  const applyHeaders = () => {
    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  };

  const originalJson = res.json?.bind(res);
  if (originalJson) {
    res.json = (body) => {
      applyHeaders();
      return originalJson(body);
    };
  }

  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    applyHeaders();
    return originalEnd(...args);
  };
}

export function handleCorsPreflight(req, res) {
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.status(204).end();
    return true;
  }

  return false;
}
