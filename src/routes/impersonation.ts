import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { createServiceClient, createAnonClient } from '../lib/supabase.js';
import { requireOrg, requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

const startBody = z.object({ targetUserId: z.string().uuid() });

const app = new Hono<{ Bindings: Bindings }>();

// Real "view as" impersonation — an owner briefly gets an actual session for
// another member of their org, so what they see is governed by that
// member's real RLS (branch/department restrictions included), not a
// client-side guess at it. start_impersonation_session() (see
// supabase/migrations/20260720130000_admin_impersonation.sql) does the
// authorization + audit logging; this route just turns its result (the
// target's email) into a real session, the same generateLink()+verifyOtp()
// trick Supabase Studio itself uses for RLS-testing impersonation.
// generateLink() only *generates* a link, it never delivers one — no email
// goes out, and the magic-link token is exchanged here, server-side, not via
// a real redirect.
app.post('/api/impersonate', validate('json', startBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .rpc('start_impersonation_session', { p_target_user_id: c.req.valid('json').targetUserId })
    .single();
  if (error) return sendPgError(c, error);

  const started = data as { session_id: string; target_email: string; target_full_name: string | null };
  const svc = createServiceClient(c.env);

  const { data: linkData, error: linkError } = await svc.auth.admin.generateLink({
    type: 'magiclink',
    email: started.target_email,
  });
  const hashedToken = linkData?.properties?.hashed_token;
  if (linkError || !hashedToken) {
    await auth.client.rpc('end_impersonation_session', { p_session_id: started.session_id });
    return c.json({ error: linkError?.message ?? 'Could not start that session.' }, 500);
  }

  const { data: verifyData, error: verifyError } = await createAnonClient(c.env).auth.verifyOtp({
    type: 'magiclink',
    token_hash: hashedToken,
  });
  if (verifyError || !verifyData.session) {
    await auth.client.rpc('end_impersonation_session', { p_session_id: started.session_id });
    return c.json({ error: verifyError?.message ?? 'Could not start that session.' }, 500);
  }

  const { session } = verifyData;
  return c.json({
    sessionId: started.session_id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ? session.expires_at * 1000 : Date.now() + (session.expires_in ?? 3600) * 1000,
    targetUserId: c.req.valid('json').targetUserId,
    targetName: started.target_full_name,
  });
});

// Best-effort — see end_impersonation_session()'s own comment for why this
// is a silent no-op rather than a 404 on an already-closed/unknown session.
app.post('/api/impersonate/:id/end', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('end_impersonation_session', { p_session_id: c.req.valid('param').id });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
