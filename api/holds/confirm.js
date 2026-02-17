import { confirmHoldById } from '../../lib/holds.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        res.status(400).json({ ok: false, error: 'INVALID_JSON' });
        return;
      }
    }
    body = body || {};
    const holdId = body.holdId;
    const stripeSessionId = body.stripeSessionId;
    const stripePaymentIntentId = body.stripePaymentIntentId;
    const missing = [];
    if (!holdId) missing.push('holdId');
    if (missing.length) {
      res.status(400).json({ ok: false, error: 'MISSING_FIELDS', missing });
      return;
    }
    const result = await confirmHoldById({ holdId, stripeSessionId, stripePaymentIntentId });
    res.status(200).json({ ok: true, confirmed: result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'INTERNAL',
      message: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
  }
}
