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
// Deliberately returns the same generic shape on "not found" as any other
// value would produce downstream (a failed sign-in) — see Login.tsx, which
// never distinguishes "no such username" from "wrong password".
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/auth/resolve-username/:username', validate('param', paramSchema), async (c) => {
  const svc = createServiceClient(c.env);
  const { data, error } = await svc
    .from('profiles')
    .select('email')
    .ilike('username', c.req.valid('param').username)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Not found.' }, 404);
  return c.json({ email: data.email });
});

export default app;
