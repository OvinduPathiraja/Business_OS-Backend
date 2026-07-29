import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

// "Scan to computer" — pairing the mobile app to a web POS session so the
// phone can act as a wireless scan gun. See
// supabase/migrations/20260728000000_scan_to_computer.sql for the data model
// and the reasoning behind it.
//
// Nothing here re-checks authorization: RLS decides who may open a session,
// who may push scans into it (only the phone that claimed it, only while it is
// live) and who may resolve them (only the host computer). These handlers just
// shape requests and map errors.
//
// Request budget: app.ts rate-limits at 300 requests / 60s per bearer token.
// One scan costs 1 request from the phone and ~2 from the computer (resolve +
// the debounced cart push), so a human with a phone is nowhere near the cap.
// If the web's cart-summary push is ever un-debounced, revisit that.

const PAIR_CODE_LENGTH = 6;
// No 0/O/1/I/L/U — the code is read aloud across a counter when the QR won't
// scan. Mirrored by PAIR_CODE_LENGTH / parsePairPayload in shared/scanSession.ts.
const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_CODE_ATTEMPTS = 5;

const createBody = z.object({
  hostLabel: z.string().trim().max(60).optional(),
  hostInstance: z.string().trim().max(40).optional(),
});

const claimBody = z.object({
  code: z.string().trim().min(4).max(12),
  deviceLabel: z.string().trim().max(60).optional(),
});

// `status` only ever moves to 'ended' from a client — 'linked' is the claim
// RPC's business and 'pending' is the initial state.
const patchSessionBody = z
  .object({
    cartItemCount: z.number().int().min(0).max(10000).optional(),
    cartTotal: z.number().min(0).optional(),
    // Rewritten when another browser tab adopts this session — that write is
    // what lets the previous tab notice it has been superseded.
    hostInstance: z.string().trim().max(40).optional(),
    status: z.literal('ended').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const pushEventBody = z.object({
  code: z.string().trim().min(1).max(128),
  clientScanId: z.string().trim().min(1).max(64),
});

// Which end of a pairing the caller is asking about — see the route comment.
const currentQuery = z.object({ role: z.enum(['host', 'device']).optional() });

const listEventsQuery = z.object({
  status: z.enum(['pending', 'added', 'unknown', 'out_of_stock', 'error', 'all']).optional().default('pending'),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

const resolveEventBody = z.object({
  status: z.enum(['added', 'unknown', 'out_of_stock', 'error']),
  resultText: z.string().trim().max(200),
});

const SESSION_SELECT =
  'id, organization_id, pair_code, status, host_user_id, host_label, host_instance, ' +
  'device_user_id, device_label, cart_item_count, cart_total, created_at, linked_at, ' +
  'last_activity_at, expires_at, ended_at';

const EVENT_SELECT =
  'id, session_id, code, client_scan_id, status, result_text, created_at, resolved_at';

function sessionFromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    pairCode: row.pair_code,
    status: row.status,
    hostUserId: row.host_user_id,
    hostLabel: row.host_label,
    hostInstance: row.host_instance,
    deviceUserId: row.device_user_id,
    deviceLabel: row.device_label,
    cartItemCount: Number(row.cart_item_count ?? 0),
    // numeric comes back from PostgREST as a string — Number() here so REST
    // and the Realtime mapper in shared/scanSession.ts agree on the type.
    cartTotal: Number(row.cart_total ?? 0),
    createdAt: row.created_at,
    linkedAt: row.linked_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  };
}

function eventFromRow(row: any) {
  return {
    id: row.id,
    sessionId: row.session_id,
    code: row.code,
    clientScanId: row.client_scan_id,
    status: row.status,
    resultText: row.result_text,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function generatePairCode(): string {
  const bytes = new Uint8Array(PAIR_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length];
  return out;
}

const app = new Hono<{ Bindings: Bindings }>();

// Opens a session and returns the code to put on screen. Also the hook the
// lifetime sweep hangs off — pairing happens a handful of times a day per org
// while scanning happens hundreds of times, so this is the cheap place for it.
app.post('/api/scan-sessions', validate('json', createBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { hostLabel, hostInstance } = c.req.valid('json');

  // Best-effort: a failed sweep must never block a cashier from pairing.
  await auth.client.rpc('prune_scan_data');

  // Retire this computer's own earlier sessions, so reopening the pairing
  // dialog doesn't leave a trail of live codes behind it.
  await auth.client
    .from('scan_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString(), ended_by_user_id: auth.userId })
    .eq('host_user_id', auth.userId)
    .in('status', ['pending', 'linked']);

  // Retry on 23505: the partial unique index covers pending codes per org, so
  // a collision is possible but vanishingly rare.
  for (let attempt = 0; attempt < PAIR_CODE_ATTEMPTS; attempt++) {
    const { data, error } = await auth.client
      .from('scan_sessions')
      .insert({
        organization_id: auth.organizationId,
        pair_code: generatePairCode(),
        host_user_id: auth.userId,
        host_label: hostLabel ?? null,
        host_instance: hostInstance ?? null,
      })
      .select(SESSION_SELECT)
      .single();

    if (!error) return c.json(sessionFromRow(data));
    if (error.code !== '23505') return sendPgError(c, error);
  }

  return c.json({ error: 'Could not generate a pairing code — try again.', code: 'PAIR_CODE_EXHAUSTED' }, 409);
});

// How both apps recover a pairing after a reload, a restart, or being
// backgrounded: ask the server rather than trusting anything stored locally.
// Registered before any '/api/scan-sessions/:id'-shaped route.
//
// `role` is which END of a pairing the caller is, and callers must send it.
// The server CANNOT reliably infer it: one account signed in on both the till
// and the phone (an owner-operator, or anyone testing alone) makes
// host_user_id and device_user_id the same value, and identity alone then says
// "host" to both. The phone, told it was the host, used to conclude it had no
// pairing and silently unlink itself on its next poll.
app.get('/api/scan-sessions/current', validate('query', currentQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { role: asRole } = c.req.valid('query');

  let query = auth.client
    .from('scan_sessions')
    .select(SESSION_SELECT)
    .in('status', ['pending', 'linked'])
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  // Match on the column for the end being asked about. For 'device' this also
  // excludes not-yet-claimed sessions for free — their device_user_id is null.
  if (asRole === 'host') query = query.eq('host_user_id', auth.userId);
  else if (asRole === 'device') query = query.eq('device_user_id', auth.userId);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);

  const row = (data ?? [])[0];
  if (!row) return c.json({ session: null, role: null });

  const session = sessionFromRow(row);
  // Trust what the caller said it is; fall back to inference only for a caller
  // that sent nothing (no shipped client does, but the param stays optional so
  // an older build in the wild keeps its previous behaviour rather than 400ing).
  const role = asRole ?? (session.hostUserId === auth.userId ? 'host' : 'device');
  return c.json({ session, role });
});

// The phone redeems a pair code. All of the work (atomicity against two phones
// scanning the same screen, and seeing a row that isn't visible to the claimer
// yet) is in the SECURITY DEFINER RPC; its exception messages are already
// written for a cashier to read, and P0001 maps to 400.
app.post('/api/scan-sessions/claim', validate('json', claimBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { code, deviceLabel } = c.req.valid('json');
  const { data, error } = await auth.client.rpc('claim_scan_session', {
    p_code: code,
    p_device_label: deviceLabel ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(sessionFromRow(data));
});

// Cart summary pushes from the computer, and Unlink from either side.
app.patch('/api/scan-sessions/:id', validate('param', uuidParam), validate('json', patchSessionBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { cartItemCount, cartTotal, hostInstance, status } = c.req.valid('json');
  const now = new Date().toISOString();
  const patch: Record<string, any> = { last_activity_at: now };

  if (cartItemCount !== undefined) patch.cart_item_count = cartItemCount;
  if (cartTotal !== undefined) patch.cart_total = cartTotal;
  if (hostInstance !== undefined) patch.host_instance = hostInstance;

  if (status === 'ended') {
    patch.status = 'ended';
    patch.ended_at = now;
    // A user id rather than a 'host' | 'device' enum, so ending needs no
    // read-before-write to work out which side asked.
    patch.ended_by_user_id = auth.userId;
  } else {
    // Any activity slides the window forward — this is what lets a pairing
    // survive a phone being pocketed between customers.
    patch.expires_at = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  }

  const { data, error } = await auth.client
    .from('scan_sessions')
    .update(patch)
    .eq('id', c.req.valid('param').id)
    .select(SESSION_SELECT)
    .single();
  if (error) return sendPgError(c, error);

  return c.json(sessionFromRow(data));
});

// The phone pushes a barcode. Idempotent on clientScanId: a retry after a lost
// response returns the original row with 200 rather than adding a second unit
// to a real customer's bill.
app.post('/api/scan-sessions/:id/events', validate('param', uuidParam), validate('json', pushEventBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const sessionId = c.req.valid('param').id;
  const { code, clientScanId } = c.req.valid('json');

  const { data, error } = await auth.client
    .from('scan_events')
    .insert({
      organization_id: auth.organizationId,
      session_id: sessionId,
      code,
      client_scan_id: clientScanId,
    })
    .select(EVENT_SELECT)
    .single();

  if (error) {
    if (error.code !== '23505') return sendPgError(c, error);
    const { data: existing, error: readErr } = await auth.client
      .from('scan_events')
      .select(EVENT_SELECT)
      .eq('session_id', sessionId)
      .eq('client_scan_id', clientScanId)
      .single();
    if (readErr) return sendPgError(c, readErr);
    return c.json(eventFromRow(existing));
  }

  // Fire-and-forget: the scan itself has already landed, and a failed keepalive
  // must not fail the request the cashier is waiting on.
  await auth.client
    .from('scan_sessions')
    .update({
      last_activity_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    })
    .eq('id', sessionId);

  return c.json(eventFromRow(data));
});

// The computer's catch-up after a dropped websocket. Oldest first: scans have
// to reach the cart in the order they were physically taken.
app.get('/api/scan-sessions/:id/events', validate('param', uuidParam), validate('query', listEventsQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status, limit } = c.req.valid('query');
  let query = auth.client
    .from('scan_events')
    .select(EVENT_SELECT)
    .eq('session_id', c.req.valid('param').id)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (status !== 'all') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(eventFromRow));
});

// The computer reports what the scan actually did. Only the host can reach
// this row (RLS) — the phone must not be able to mark its own scan "added",
// because the result has to reflect what genuinely reached the cart.
app.patch('/api/scan-events/:id', validate('param', uuidParam), validate('json', resolveEventBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status, resultText } = c.req.valid('json');
  const { data, error } = await auth.client
    .from('scan_events')
    .update({ status, result_text: resultText, resolved_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(EVENT_SELECT)
    .single();
  if (error) return sendPgError(c, error);

  return c.json(eventFromRow(data));
});

export default app;
