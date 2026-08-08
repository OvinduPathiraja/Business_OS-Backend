import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { createServiceClient, createAnonClient } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sessionIdFromJwt } from '../../lib/auth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { uuidParam } from '../../lib/schemas.js';

// Cross-tenant "sign in as", for reproducing a support issue as the customer
// actually sees it.
//
// The session mint is byte-for-byte the same trick routes/impersonation.ts
// already uses for the tenant-side feature: generateLink() produces a magic
// link WITHOUT sending any email, and the hashed token is exchanged for a real
// session here, server-side. Authorization and audit live in
// start_platform_impersonation() (see the 20260730060000 migration).
//
// HANDOFF: the response includes a URL into the tenant app carrying the session
// in the URL fragment. That works with no change to the tenant app because its
// Supabase client already runs with `detectSessionInUrl: true` on web (see
// frontend/src/lib/supabase.ts), which is the same mechanism Supabase's own
// invite and password-recovery emails rely on.

const app = new Hono<{ Bindings: Bindings }>();

const startBody = z.object({
  targetUserId: z.string().uuid(),
  organizationId: z.string().uuid(),
  // Free text, stored in platform_audit_log. Required by the console's UI so
  // there is always a stated purpose attached to a support sign-in.
  reason: z.string().trim().max(500).optional(),
});

app.post('/api/admin/impersonate', validate('json', startBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'support');
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');

  const { data, error } = await auth.client
    .rpc('start_platform_impersonation', {
      p_target_user_id: body.targetUserId,
      p_organization_id: body.organizationId,
      p_reason: body.reason ?? null,
    })
    .single();
  if (error) return sendPgError(c, error);

  const started = data as {
    session_id: string;
    target_email: string;
    target_full_name: string | null;
    organization_name: string;
  };

  const svc = createServiceClient(c.env);
  const { data: linkData, error: linkError } = await svc.auth.admin.generateLink({
    type: 'magiclink',
    email: started.target_email,
  });
  const hashedToken = linkData?.properties?.hashed_token;
  if (linkError || !hashedToken) {
    await auth.client.rpc('end_platform_impersonation', { p_session_id: started.session_id });
    return c.json({ error: linkError?.message ?? 'Could not start that session.' }, 500);
  }

  const { data: verifyData, error: verifyError } = await createAnonClient(c.env).auth.verifyOtp({
    type: 'magiclink',
    token_hash: hashedToken,
  });
  if (verifyError || !verifyData.session) {
    await auth.client.rpc('end_platform_impersonation', { p_session_id: started.session_id });
    return c.json({ error: verifyError?.message ?? 'Could not start that session.' }, 500);
  }

  const { session } = verifyData;

  // See routes/impersonation.ts's identical block — records which specific
  // auth session this token belongs to, so requireUser()'s
  // is_impersonation_write_blocked() check can enforce read-only access
  // server-side. Uses the platform admin's own client (auth.client, from
  // requirePlatformAdmin() above), never the target's.
  const targetSessionId = sessionIdFromJwt(session.access_token);
  if (targetSessionId) {
    const { error: recordError } = await auth.client.rpc('record_impersonation_auth_session', {
      p_session_id: started.session_id,
      p_auth_session_id: targetSessionId,
    });
    if (recordError) {
      await auth.client.rpc('end_platform_impersonation', { p_session_id: started.session_id });
      return c.json({ error: 'Could not start that session.' }, 500);
    }
  }

  return c.json({
    sessionId: started.session_id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at
      ? session.expires_at * 1000
      : Date.now() + (session.expires_in ?? 3600) * 1000,
    targetUserId: body.targetUserId,
    targetName: started.target_full_name,
    targetEmail: started.target_email,
    organizationName: started.organization_name,
    // Opened in a new tab by the console. type=magiclink matches what the
    // tenant app's own hash handling already expects.
    handoffUrl:
      `${c.env.PUBLIC_APP_URL.replace(/\/$/, '')}/#access_token=${encodeURIComponent(session.access_token)}` +
      `&refresh_token=${encodeURIComponent(session.refresh_token)}&type=magiclink`,
  });
});

// Best-effort close, mirroring the tenant-side route's behaviour: the token
// expiring is what actually ends access either way, so a failure here is not
// worth surfacing as an error. See end_platform_impersonation()'s own comment
// for why it can't reuse end_impersonation_session().
//
// C2 residual gap (2026-08-06 security assessment) — same fix as
// routes/impersonation.ts: ending the session previously only wrote
// ended_at, leaving the actual JWT usable for reads until its natural
// expiry. accessToken (the target's impersonation token — the same one this
// route's own /api/admin/impersonate response and handoffUrl already hand
// the operator) is read manually, not via validate('json', ...), so a
// caller sending no body still parses cleanly. Scope 'local': revokes only
// this specific impersonation session, never the target's own real session.
//
// Bound to the session actually being closed (2026-08-08 assessment,
// finding #9, supabase/migrations/20260808050000_bind_impersonation_end_
// accesstoken.sql) — a caller-supplied token that doesn't match the
// auth_session_id this RPC just resolved is silently ignored rather than
// handed to signOut(), so an already-privileged caller can no longer force
// an arbitrary unrelated session to sign out through this route.
app.post('/api/admin/impersonate/:id/end', validate('param', uuidParam), async (c) => {
  const auth = await requirePlatformAdmin(c, 'support');
  if (auth instanceof Response) return auth;

  const { data: authSessionId, error } = await auth.client.rpc('end_platform_impersonation', {
    p_session_id: c.req.valid('param').id,
  });
  if (error) return sendPgError(c, error);

  const accessToken = await c.req
    .json()
    .then((body) => (typeof body?.accessToken === 'string' ? body.accessToken : null))
    .catch(() => null);
  if (accessToken && authSessionId && sessionIdFromJwt(accessToken) === authSessionId) {
    await createServiceClient(c.env).auth.admin.signOut(accessToken, 'local').catch(() => {});
  }

  return c.body(null, 204);
});

// Recent sessions, for the audit screen. Service client: impersonation_sessions
// is RLS-scoped to a single org's owner, which by design cannot see the
// cross-tenant list.
app.get('/api/admin/impersonations', async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.svc
    .from('impersonation_sessions')
    .select('id, organization_id, admin_user_id, target_user_id, started_at, ended_at, is_platform_session')
    .eq('is_platform_session', true)
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) return sendPgError(c, error);

  const rows = (data ?? []) as Record<string, unknown>[];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.admin_user_id as string, r.target_user_id as string])),
  ].filter(Boolean);
  const orgIds = [...new Set(rows.map((r) => r.organization_id as string))].filter(Boolean);

  const [profiles, orgs] = await Promise.all([
    userIds.length
      ? auth.svc.from('profiles').select('id, full_name, email').in('id', userIds)
      : Promise.resolve({ data: [] }),
    orgIds.length
      ? auth.svc.from('organizations').select('id, name').in('id', orgIds)
      : Promise.resolve({ data: [] }),
  ]);

  const nameOf = new Map(
    ((profiles.data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map(
      (p) => [p.id, p.full_name ?? p.email ?? null],
    ),
  );
  const orgOf = new Map(((orgs.data ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));

  return c.json(
    rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      organizationName: orgOf.get(r.organization_id as string) ?? null,
      adminName: nameOf.get(r.admin_user_id as string) ?? null,
      targetName: nameOf.get(r.target_user_id as string) ?? null,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    })),
  );
});

export default app;
