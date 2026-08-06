import { createClient } from '@supabase/supabase-js';
import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';

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
  // Cloudflare Analytics, read by the operator console's Traffic screen
  // (backend/src/lib/cloudflareAnalytics.ts). Optional — the screen reports
  // "not configured" and falls back to its other tabs when these are unset,
  // so nothing breaks if they're never provided.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // Kill switch for the subscription read-only gate in lib/auth.ts. Defaults
  // to OFF, and that default is load-bearing rather than cautious:
  // 20260730010000_platform_billing.sql backfilled every organization that
  // existed at apply time onto a 14-day trial dated from that day, so if the
  // backfill is more than two weeks old, switching this on without first
  // reconciling real subscriptions puts the entire customer base into
  // read-only in one deploy. Ship dark, reconcile, then flip the var.
  SUBSCRIPTION_GATE?: 'on' | 'off';
  // The registrable domain the session cookies are scoped to — NOT the
  // Worker's own exact hostname. businessos.*.workers.dev and
  // businessosbackend.*.workers.dev share this as their eTLD+1 (verified
  // directly against the real Public Suffix List: `workers.dev` itself is
  // the PSL entry, not the account subdomain), so a cookie set with this as
  // its Domain reaches both. `localhost` locally (no Secure, since plain
  // http://localhost cookie behavior is inconsistent across browsers even
  // though Chrome special-cases it as a secure context).
  COOKIE_DOMAIN: string;
  // H6 fix (2026-08-04 security assessment, closed 2026-08-06): dedicated
  // login brute-force protection, wired into POST /api/auth/login
  // (routes/session.ts) only. LOGIN_RATE_LIMITER is the fast per-request
  // volumetric guard (keyed by email, not IP — see wrangler.toml's comment);
  // LOGIN_ATTEMPTS backs the real 5-attempts/15-minute account lockout in
  // lib/loginAttempts.ts, since the rate limiter's period is capped at 60s.
  LOGIN_RATE_LIMITER: RateLimit;
  LOGIN_ATTEMPTS: KVNamespace;
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

type HonoContext = Context<{ Bindings: Bindings }>;

// httpOnly session cookies — the M3 fix (2026-08-04 security assessment):
// the web app's session used to live in localStorage, readable by any script
// on the page. These two cookies are the only place a web session lives now;
// requireUser() (lib/auth.ts) falls back to reading ACCESS_COOKIE when no
// Authorization header is present. Never exposed in a JSON response body —
// every route in routes/session.ts that mints or refreshes a session sets
// these directly and returns no token in its body.
export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';

// SameSite=Lax (not None) is correct here, not a weaker fallback: businessos
// and businessosbackend share their registrable domain (see the Bindings
// comment on COOKIE_DOMAIN above), so this is a same-site, cross-origin
// relationship — Lax already allows normal cross-origin fetch() calls to
// carry the cookie, it only withholds it on cross-SITE top-level navigation,
// which is exactly the CSRF vector we want blocked.
function cookieBaseOptions(env: Bindings) {
  return {
    domain: env.COOKIE_DOMAIN,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: env.COOKIE_DOMAIN !== 'localhost',
  };
}

// accessExpiresIn/refreshExpiresIn are seconds, as Supabase's own session
// object reports them (session.expires_in). Falls back to a conservative
// 1 hour / 30 days if a caller ever has neither on hand (e.g. a
// same-request refresh where only the new session is known).
export function setSessionCookies(
  c: HonoContext,
  accessToken: string,
  refreshToken: string,
  accessExpiresIn?: number
): void {
  const opts = cookieBaseOptions(c.env);
  setCookie(c, ACCESS_COOKIE, accessToken, { ...opts, maxAge: accessExpiresIn ?? 3600 });
  // Refresh tokens are rotating/single-use in Supabase's default config —
  // sized generously rather than to a specific known lifetime, since the
  // cookie merely bounds how long an UNUSED refresh token can sit before
  // this app stops offering it; Supabase's own expiry is still the real
  // authority and a stale/already-used one simply fails at refresh time.
  setCookie(c, REFRESH_COOKIE, refreshToken, { ...opts, maxAge: 60 * 60 * 24 * 30 });
}

export function clearSessionCookies(c: HonoContext): void {
  const opts = cookieBaseOptions(c.env);
  deleteCookie(c, ACCESS_COOKIE, opts);
  deleteCookie(c, REFRESH_COOKIE, opts);
}
