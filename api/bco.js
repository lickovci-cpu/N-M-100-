import { createHash } from 'node:crypto';

const BCO_URL = 'https://business-control-one.vercel.app/api/integrations/webhook';
const SECRET = process.env.BCO_INTEGRATION_SECRET || '';
const MAX_BODY = 50000;

function json(res, status, data) {
  return res.status(status).json(data);
}
function clean(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
function hash(v) { return createHash('sha256').update(JSON.stringify(v)).digest('hex'); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!SECRET) return json(res, 503, { error: 'BCO_INTEGRATION_SECRET_NOT_CONFIGURED' });

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) return json(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'INVALID_JSON' }); }

    const eventType = clean(input.event_type || input.type, 80).toLowerCase();
    if (!['message.created', 'message.received', 'inquiry.created', 'order.created', 'checkout.created'].includes(eventType)) {
      return json(res, 400, { error: 'UNSUPPORTED_EVENT_TYPE' });
    }

    const payload = input.payload && typeof input.payload === 'object' ? input.payload : input;
    const eventId = clean(input.event_id || input.idempotency_key || payload.order_id || payload.message_id, 180) || hash({ eventType, payload });
    const upstream = {
      project: 'merch',
      event_type: eventType,
      event_id: eventId,
      payload: {
        ...payload,
        page_url: clean(payload.page_url || req.headers.referer || '', 500),
        source: clean(payload.source || 'nrsn-web', 120)
      }
    };

    const r = await fetch(BCO_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${SECRET}`,
        'x-bco-integration-key': SECRET
      },
      body: JSON.stringify(upstream),
      signal: AbortSignal.timeout(12000)
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
    if (!r.ok) return json(res, r.status >= 500 ? 502 : r.status, { error: 'BCO_UPSTREAM_ERROR', upstream_status: r.status, detail: data });
    return json(res, 202, { ok: true, forwarded: true, event_type: eventType, event_id: eventId, bco: data });
  } catch (e) {
    console.error('NRSN_BCO_BRIDGE_ERROR', String(e?.message || e));
    return json(res, 502, { error: 'BCO_BRIDGE_FAILED' });
  }
}
