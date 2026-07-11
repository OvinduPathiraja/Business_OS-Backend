import { createClient } from '@supabase/supabase-js';

// Workers has no process.env — config/secrets come from the `env` object
// Cloudflare passes into the fetch handler, typed here and threaded through
// every route via Hono's Context<{ Bindings }>.
export type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_ORIGIN: string;
  RATE_LIMITER: RateLimit;
};

// Runs every query *as* the calling user (their JWT is forwarded as the
// bearer token), so Postgres RLS — not hand-rolled auth logic here — decides
// what they can see or do. This is the client every route should use unless
// a specific operation genuinely requires bypassing RLS.
export function createUserClient(env: Bindings, accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Bypasses RLS entirely via the service-role key. Not called by any route
// yet (reserved for privileged operations added later, e.g. the Supabase
// Admin API for real employee invites).
export function createServiceClient(env: Bindings) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set to use the service client.');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function bearerTokenFrom(authHeader: string | undefined | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token || null;
}
