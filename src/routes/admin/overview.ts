import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';

const app = new Hono<{ Bindings: Bindings }>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shared by every operator screen that takes a window. Unlike the tenant-facing
// dashboard (which caps at MAX_RANGE_DAYS = 90 because it scans a tenant's raw
// order rows), these read pre-aggregated RPCs, so a wider window is affordable.
export const rangeQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});

// Who am I. The console calls this immediately after sign-in and signs the user
// straight back out if it 403s, which is what keeps a normal tenant account
// from ever seeing the operator shell.
app.get('/api/admin/me', async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.svc
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', auth.userId)
    .single();
  if (error) return sendPgError(c, error);

  return c.json({
    id: data.id,
    fullName: data.full_name,
    email: data.email,
    role: auth.role,
    // Drives which actions the UI offers. The server re-checks rank on every
    // mutating route regardless — this is for hiding buttons, not for security.
    can: {
      viewOnly: auth.role === 'analyst',
      manageInquiries: ['support', 'billing', 'superadmin'].includes(auth.role),
      manageBilling: ['billing', 'superadmin'].includes(auth.role),
      impersonate: ['support', 'billing', 'superadmin'].includes(auth.role),
      suspendOrgs: auth.role === 'superadmin',
      manageAdmins: auth.role === 'superadmin',
      // Creating a customer's account + workspace + plan is a billing act:
      // it commits them to a price. Signing one of their devices out is
      // help-desk work, so it sits a rank lower.
      provision: ['billing', 'superadmin'].includes(auth.role),
      manageDevices: ['support', 'billing', 'superadmin'].includes(auth.role),
    },
  });
});

app.get('/api/admin/overview', validate('query', rangeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_overview', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(data);
});

export default app;
