import { createClient } from '@supabase/supabase-js';

// Workers has no process.env — config/secrets come from the `env` object
// Cloudflare passes into the fetch handler, typed here and threaded through
// every route via Hono's Context<{ Bindings }>.
export type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_ORIGIN: string;
  // Deployed frontend URL — passed as `redirectTo` for admin.inviteUserByEmail
  // so the invite email's link lands back on this app. Must be allow-listed
  // in Supabase Dashboard -> Authentication -> URL Configuration.
  PUBLIC_APP_URL: string;
  RATE_LIMITER: RateLimit;
  // Transactional email for the existing-user org-invite notification (see
  // backend/src/lib/email.ts) — Resend, the one email provider this project
  // uses. Nothing else sends real email; Supabase Auth's own emails (new-
  // account invites) don't go through this.
  RESEND_API_KEY: string;
  EMAIL_FROM_ADDRESS: string;
};

// Runs every query *as* the calling user (their JWT is forwarded as the
// bearer token), so Postgres RLS — not hand-rolled auth logic here — decides
// what they can see or do. This is the client every route should use unless
// a specific operation genuinely requires bypassing RLS. `organizationId`,
// when present, is forwarded as X-Organization-Id — current_organization_id()
// reads it straight off the PostgREST request GUCs to resolve which of the
// caller's (possibly several) org memberships is active for this request.
export function createUserClient(env: Bindings, accessToken: string, organizationId?: string | null) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (organizationId) headers['X-Organization-Id'] = organizationId;
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Bypasses RLS entirely via the service-role key. Used by the employee
// invite route (backend/src/routes/employees.ts) to call the Supabase Admin
// API — the one operation that genuinely needs to create an auth.users row
// on another person's behalf.
export function createServiceClient(env: Bindings) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set to use the service client.');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// A plain, unauthenticated client — used only to exchange a magic-link
// token_hash for a real session via verifyOtp() (see
// backend/src/routes/impersonation.ts, the "view as" admin feature).
// verifyOtp() authenticates by the token_hash itself, so this needs no
// bearer token and no service-role key.
export function createAnonClient(env: Bindings) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function bearerTokenFrom(authHeader: string | undefined | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token || null;
}
