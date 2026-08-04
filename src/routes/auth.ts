import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient } from '../lib/supabase.js';
import type { Bindings } from '../lib/supabase.js';
import { validate } from '../lib/validate.js';

const paramSchema = z.object({ username: z.string().trim().min(1) });

// Public (no bearer token — there's nothing to authenticate yet, this runs
// before sign-in) lookup so Login.tsx can accept either a real email or a
// username-account's username: resolve the username to its synthetic email
// (see supabase/migrations/20260724010000_username_accounts.sql and
// backend/src/routes/employees.ts's username-invite route), then call
// supabase.auth.signInWithPassword() with that like any other account.
//
// Found during the 2026-08-04 security assessment: this route used to
// return a definitive 404 for an unknown username vs 200 {email} for a real
// one — a direct enumeration oracle, rate-limited only by the generic
// 300 req/60s-per-IP budget (~5 req/s). The comment above (about Login.tsx
// never distinguishing "no such username" from "wrong password") describes
// the FULL login flow's behavior, not this endpoint's own response, which a
// direct caller bypasses entirely.
//
// Fix: for an unknown username, return 200 with a deterministic but
// guaranteed-nonexistent email instead of 404. The frontend's subsequent
// signInWithPassword() call then fails with Supabase's own generic "Invalid
// login credentials" — byte-for-byte the same outcome as a real username
// with the wrong password — so the response from THIS route no longer
// reveals anything. The real DB lookup still runs in both branches (rather
// than short-circuiting on a cheap format check), so response timing stays
// close between the two cases too.
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/auth/resolve-username/:username', validate('param', paramSchema), async (c) => {
  const svc = createServiceClient(c.env);
  const username = c.req.valid('param').username;
  const { data, error } = await svc
    .from('profiles')
    .select('email')
    .ilike('username', username)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ email: `${encodeURIComponent(username)}@no-such-user.businessos.invalid` });
  return c.json({ email: data.email });
});

export default app;
