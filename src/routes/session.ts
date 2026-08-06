import { Hono } from 'hono';
import { z } from 'zod';
import { createAnonClient, createServiceClient, setSessionCookies, clearSessionCookies, ACCESS_COOKIE, REFRESH_COOKIE } from '../lib/supabase.js';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { validate } from '../lib/validate.js';
import { getCookie } from 'hono/cookie';
import { passwordIssues } from '../lib/passwordPolicy.js';

// The M3 fix (2026-08-04 security assessment): the web session used to live
// in localStorage (readable by any script on the page). These routes are
// the only place a web session is minted or refreshed now — the resulting
// tokens are set as httpOnly cookies and NEVER included in a JSON response
// body, so frontend JS never holds them at all for password login/signup.
//
// OAuth, invite-acceptance and password-recovery can't go through login/
// signup (Supabase delivers those sessions via a URL fragment, which
// browsers never transmit to a server) — adopt-session is their landing
// point instead: the frontend lets supabase-js finish that flow exactly as
// before (still landing a session in memory), then immediately hands the
// resulting tokens here to be cookie-ified, then wipes its own local copy
// (supabase.auth.signOut({scope:'local'})). This reduces (rather than
// eliminates) their exposure window — a few JS ticks instead of persisting
// indefinitely — which is the best achievable outcome given Supabase
// delivers these sessions client-side by design.

const app = new Hono<{ Bindings: Bindings }>();

const loginBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

app.post('/api/auth/login', validate('json', loginBody), async (c) => {
  const { email, password } = c.req.valid('json');
  const { data, error } = await createAnonClient(c.env).auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    // Relay Supabase's own status/message rather than hardcoding one — this
    // is what preserves Login.tsx's existing lockout/error-copy handling
    // (getLockoutStatus/recordFailedAttempt) verbatim, since it reads the
    // same generic wording signInWithPassword always produced client-side.
    return c.json({ error: error?.message ?? 'Could not sign in.' }, (error?.status ?? 400) as 400);
  }
  setSessionCookies(c, data.session.access_token, data.session.refresh_token, data.session.expires_in);
  return c.json({ error: null });
});

const signupBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  fullName: z.string().trim().min(1),
});

app.post('/api/auth/signup', validate('json', signupBody), async (c) => {
  const { email, password, fullName } = c.req.valid('json');

  // H5 fix (2026-08-04 security assessment, closed 2026-08-06): this route
  // is what makes server-side enforcement possible at all for regular
  // signup — before the M3 migration, signUp() went straight from the
  // browser to Supabase Auth, with nothing server-side to check against.
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    return c.json({ error: `Password needs ${issues.join(', ')}.` }, 400);
  }

  const { data, error } = await createAnonClient(c.env).auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName }, emailRedirectTo: c.env.PUBLIC_APP_URL },
  });
  if (error) return c.json({ error: error.message }, (error.status ?? 400) as 400);

  // With email confirmation required (this project's config), Supabase
  // deliberately returns "success" (no error) for an email that's already
  // registered, to avoid leaking existence via an error message — the
  // account it hands back has a real user id but an empty `identities`
  // array. That's the one reliable signal a duplicate happened. Mirrors
  // auth.tsx's prior client-side check verbatim.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return c.json({ error: 'An account with this email already exists. Try signing in instead.' });
  }

  // A genuinely new signup with email confirmation ON returns no session —
  // nothing to cookie-ify yet, matches today's "check your email" flow. If
  // confirmation is ever turned off, this still does the right thing.
  if (data.session) {
    setSessionCookies(c, data.session.access_token, data.session.refresh_token, data.session.expires_in);
  }
  return c.json({ error: null });
});

const adoptBody = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

app.post('/api/auth/adopt-session', validate('json', adoptBody), async (c) => {
  const { access_token, refresh_token } = c.req.valid('json');
  const { data, error } = await createAnonClient(c.env).auth.getUser(access_token);
  if (error || !data.user) {
    return c.json({ error: 'Invalid session.' }, 401);
  }
  setSessionCookies(c, access_token, refresh_token);
  return c.json({ error: null });
});

app.post('/api/auth/refresh', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE);
  if (!refreshToken) {
    clearSessionCookies(c);
    return c.json({ error: 'No session to refresh.' }, 401);
  }
  const { data, error } = await createAnonClient(c.env).auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    clearSessionCookies(c);
    return c.json({ error: 'Session expired.' }, 401);
  }
  // Supabase refresh tokens are single-use/rotating by default — the old
  // one stops working the moment this succeeds, so both cookies must be
  // overwritten, not just the access one.
  setSessionCookies(c, data.session.access_token, data.session.refresh_token, data.session.expires_in);
  return c.json({ error: null });
});

app.post('/api/auth/logout', async (c) => {
  const accessToken = getCookie(c, ACCESS_COOKIE);
  if (accessToken) {
    try {
      // 'global' matches today's actual client-side supabase.auth.signOut()
      // default (verified against @supabase/auth-js source) — logout's
      // real-world effect (signs out every device) is unchanged by this
      // migration, not silently narrowed to just this one.
      await createServiceClient(c.env).auth.admin.signOut(accessToken, 'global');
    } catch {
      // Best-effort — clearing the cookies below is what actually ends this
      // browser's access; a revocation failure shouldn't block that.
    }
  }
  clearSessionCookies(c);
  return c.body(null, 204);
});

const setPasswordBody = z.object({ password: z.string().min(1) });

// Authenticated via requireUser() (cookie-backed once adopt-session has
// run) rather than relying on supabase-js's own tracked client session —
// AcceptInvite.tsx's flow lands here right after an invite/recovery link's
// session was adopted-then-locally-wiped, so there is no client-side
// session left for client.auth.updateUser() to act on. admin.updateUserById()
// sidesteps that with an explicit user id instead.
app.post('/api/auth/set-password', validate('json', setPasswordBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  const { password } = c.req.valid('json');

  // H5 fix (2026-08-04 security assessment, closed 2026-08-06): this one
  // route now serves every real password-setting flow in the app —
  // invite-acceptance, recovery-completion, and Settings.tsx's self-service
  // change-password — so this single check closes the gap everywhere.
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    return c.json({ error: `Password needs ${issues.join(', ')}.` }, 400);
  }

  const { error } = await createServiceClient(c.env).auth.admin.updateUserById(auth.userId, { password });
  if (error) return c.json({ error: error.message }, (error.status ?? 400) as 400);
  return c.json({ error: null });
});

// Cookie-authenticated hand-off of the CURRENT access token, for the one
// legitimate client-side use that survives this migration: Supabase
// Realtime (Queue board ticket updates, scan-link pairing) authenticates
// its socket with a real JWT the browser holds, which a purely
// cookie-based session can't provide by nature. Deliberately narrow: called
// lazily only by screens that open a Realtime channel, fed into
// supabase.realtime.setAuth() rather than into supabase.auth's own tracked
// session state, so it never collides with the cookie-based refresh path.
app.get('/api/auth/realtime-token', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  const token = getCookie(c, ACCESS_COOKIE) ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return c.json({ error: 'No session.' }, 401);
  return c.json({ accessToken: token });
});

export default app;
