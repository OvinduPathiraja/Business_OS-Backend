import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { createServiceClient } from '../lib/supabase.js';
import { validate } from '../lib/validate.js';
import { sha256Hex } from '../lib/platformAuth.js';

// The two UNAUTHENTICATED endpoints in this API. Everything else requires a
// bearer token; these are reachable by anyone on the internet, so they get
// their own file and their own set of defences rather than being tucked in
// beside authenticated routes where the distinction could be missed later.
//
// Both write with the service-role client, because neither platform_inquiries
// nor platform_site_events grants anon any INSERT policy. That is deliberate:
// it means the validation below cannot be bypassed by talking to PostgREST
// directly, and an anonymous caller never holds a write capability against
// those tables — only the ability to ask this route to write on its behalf.
//
// Rate limiting is already applied globally in app.ts via Cloudflare's
// RATE_LIMITER binding, keyed on cf-connecting-ip for unauthenticated callers.

const app = new Hono<{ Bindings: Bindings }>();

const inquiryBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  company: z.string().trim().max(150).optional(),
  phone: z.string().trim().max(50).optional(),
  message: z.string().trim().min(1).max(5000),
  intent: z.string().trim().max(50).optional(),
  utmSource: z.string().trim().max(100).optional(),
  utmMedium: z.string().trim().max(100).optional(),
  utmCampaign: z.string().trim().max(100).optional(),
  // Honeypot: a field hidden from real users with CSS. Bots fill in every
  // input they find, so anything here means "not a human".
  website: z.string().max(200).optional(),
  // Milliseconds between the form rendering and being submitted. A human
  // cannot read the page and type a message in under ~2 seconds.
  elapsedMs: z.coerce.number().int().min(0).optional(),
});

const MIN_FILL_MS = 2000;

app.post('/api/public/inquiries', validate('json', inquiryBody), async (c) => {
  const b = c.req.valid('json');

  // Both spam checks respond with the SAME 201 a genuine submission gets.
  // Telling a bot it was detected just teaches whoever wrote it what to
  // change; the visitor-facing behaviour is identical either way.
  const looksAutomated =
    (b.website ?? '') !== '' || (b.elapsedMs !== undefined && b.elapsedMs < MIN_FILL_MS);

  const svc = createServiceClient(c.env);
  const { error } = await svc.from('platform_inquiries').insert({
    source: 'contact_form',
    intent: b.intent ?? null,
    name: b.name,
    email: b.email,
    company: b.company ?? null,
    phone: b.phone ?? null,
    message: b.message,
    // Filed as spam rather than dropped, so a false positive is recoverable
    // from the console instead of being silently lost.
    status: looksAutomated ? 'spam' : 'new',
    utm_source: b.utmSource ?? null,
    utm_medium: b.utmMedium ?? null,
    utm_campaign: b.utmCampaign ?? null,
    referrer_host: hostOf(c.req.header('referer')),
    country: c.req.header('cf-ipcountry') ?? null,
    ip_hash: await hashIpFor(c),
  });

  if (error) {
    console.error('inquiry insert failed', error.message);
    return c.json({ error: 'Could not send that just now. Please try again.' }, 500);
  }

  return c.json({ ok: true }, 201);
});

// ---------------------------------------------------------------------------
// The marketing site's page beacon. No cookie is set and no raw IP is stored —
// session_hash is a salted hash of IP + user-agent + the DATE, so it groups a
// visitor's pages within one day and is not correlatable across days.
// ---------------------------------------------------------------------------
const siteEventBody = z.object({
  event: z.enum(['pageview', 'cta_click', 'signup_start', 'contact_submit']).optional().default('pageview'),
  path: z.string().trim().min(1).max(300),
  referrer: z.string().trim().max(500).optional(),
  utmSource: z.string().trim().max(100).optional(),
  utmMedium: z.string().trim().max(100).optional(),
  utmCampaign: z.string().trim().max(100).optional(),
});

app.post('/api/public/site-events', validate('json', siteEventBody), async (c) => {
  const b = c.req.valid('json');

  // 204 regardless of what happens below. This is fired by a page beacon on a
  // marketing site; analytics must never surface an error to a visitor, and
  // the response is not read by the caller.
  try {
    const ip = c.req.header('cf-connecting-ip') ?? '';
    const ua = c.req.header('user-agent') ?? '';
    const day = new Date().toISOString().slice(0, 10);
    const sessionHash = ip
      ? await sha256Hex(`${ip}:${ua}:${day}:${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 16)
      : null;

    await createServiceClient(c.env)
      .from('platform_site_events')
      .insert({
        event: b.event,
        // Path only — a query string can carry an email from a form GET or a
        // token from a share link, and neither belongs in analytics.
        path: b.path.split('?')[0].slice(0, 300),
        referrer_host: hostOf(b.referrer),
        country: c.req.header('cf-ipcountry') ?? null,
        session_hash: sessionHash,
        utm_source: b.utmSource ?? null,
        utm_medium: b.utmMedium ?? null,
        utm_campaign: b.utmCampaign ?? null,
      });
  } catch (err) {
    console.error('site event insert threw', err);
  }

  return c.body(null, 204);
});

// Host only, never the full referring URL — the path a visitor came from can
// itself contain identifying query parameters.
function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

async function hashIpFor(c: { req: { header: (k: string) => string | undefined }; env: Bindings }) {
  const ip = c.req.header('cf-connecting-ip');
  if (!ip) return null;
  return sha256Hex(`${ip}:${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 16);
}

export default app;
