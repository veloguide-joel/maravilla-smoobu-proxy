export default function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  res.status(200).json({ ok: true, ts: new Date().toISOString() });
}
