import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';

// Device register — see 20260803000000_user_devices.sql for what this is and,
// more importantly, what it isn't (a licensing control, not a security
// boundary).
//
// Every route here must stay reachable by someone who is currently BLOCKED,
// which is the whole point: a person at their device cap can do nothing else
// until they free a slot. The two mutating routes are therefore listed in
// WRITE_ALLOWED_PATHS in lib/auth.ts — if that list and this file ever
// disagree, the symptom is a user permanently unable to sign in anywhere.
const app = new Hono<{ Bindings: Bindings }>();

const registerBody = z.object({
  deviceId: z.string().trim().min(1).max(128),
  // Coarse "Chrome · Windows", never a raw user-agent. Capped short so a
  // hostile client can't use it as free storage; the column has no other
  // validation because there is nothing meaningful to validate.
  label: z.string().trim().max(80).optional(),
  platform: z.enum(['web', 'ios', 'android', 'unknown']).optional(),
  app: z.enum(['business-os', 'cashier']).optional(),
});

const deviceParam = z.object({ deviceId: z.string().trim().min(1).max(128) });

// Called once at app start, after sign-in. A refusal is a 200 with
// allowed:false rather than a 403 — the device list travels with it, and the
// blocked screen renders straight from this one response instead of making a
// follow-up call.
app.post('/api/devices/register', validate('json', registerBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client.rpc('register_device', {
    p_device_id: body.deviceId,
    p_label: body.label ?? null,
    p_platform: body.platform ?? 'unknown',
    p_app: body.app ?? 'business-os',
    // The GoTrue session id, captured for a per-device session kill we
    // deliberately do not attempt yet (see the migration header). Read off the
    // caller's own token rather than trusted from the body.
    p_session_id: sessionIdFromJwt(c.req.header('authorization')),
  });
  if (error) return sendPgError(c, error);

  return c.json(data);
});

app.get('/api/devices', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const [devicesResult, limitResult] = await Promise.all([
    auth.client.rpc('my_devices'),
    auth.client.rpc('my_device_limit'),
  ]);
  if (devicesResult.error) return sendPgError(c, devicesResult.error);
  if (limitResult.error) return sendPgError(c, limitResult.error);

  return c.json({ devices: devicesResult.data ?? [], limit: limitResult.data ?? 2 });
});

// Signing out the CURRENT device is allowed and is not a mistake — it is both
// "sign out everywhere including here" and the only way somebody at their cap
// on their only machine can free a slot.
app.post('/api/devices/:deviceId/revoke', validate('param', deviceParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.rpc('revoke_device', {
    p_device_id: c.req.valid('param').deviceId,
  });
  if (error) return sendPgError(c, error);

  return c.json(data);
});

// Reads the `session_id` claim without verifying the signature — same
// approach, and the same justification, as subjectFromJwt() in
// lib/requestLog.ts: requireUser() has already verified this exact token with
// Supabase by the time we get here, so this is decoding a value we have
// already trusted, not deciding whether to trust it. Returns null on anything
// unexpected; the column is optional and unread.
function sessionIdFromJwt(authHeader: string | undefined): string | null {
  try {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const payload = token?.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { session_id?: string };
    return typeof claims.session_id === 'string' ? claims.session_id : null;
  } catch {
    return null;
  }
}

export default app;
