import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

const createOrgBody = z.object({ name: z.string().trim().min(1) });
const updateCurrencyBody = z.object({ currency: z.string().length(3) });
const settingsBody = z.object({
  screenType: z.enum(['guided', 'single', 'compact']).optional(),
  controlSize: z.enum(['comfortable', 'large', 'xlarge']).optional(),
  productsEnabled: z.boolean().optional(),
  bookingsEnabled: z.boolean().optional(),
});

const app = new Hono<{ Bindings: Bindings }>();

// Onboarding — the caller has no org yet, so requireUser() only (there is
// nothing for requireOrg() to find). Thin wrapper: create_organization()
// is already a correct, atomic SECURITY DEFINER RPC.
app.post('/api/organizations', validate('json', createOrgBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.rpc('create_organization', { org_name: c.req.valid('json').name });
  if (error) return sendPgError(c, error);
  return c.json({ organizationId: data }, 201);
});

// The following 4 routes all act on a membership the caller has in an
// explicit :id org — deliberately requireUser, not requireOrg, since the
// target org is frequently NOT the caller's currently-active one (switching
// away from it, or accepting/declining an invite to an org they've never
// been active in yet). Each is a thin wrapper over the corresponding
// self-service RPC, which does the real membership validation.

app.post('/api/organizations/:id/switch', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('switch_active_organization', {
    p_organization_id: c.req.valid('param').id,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.post('/api/organizations/:id/accept', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('accept_organization_invite', {
    p_organization_id: c.req.valid('param').id,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.post('/api/organizations/:id/decline', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('decline_organization_invite', {
    p_organization_id: c.req.valid('param').id,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.post('/api/organizations/:id/leave', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('leave_organization', {
    p_organization_id: c.req.valid('param').id,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Permanent, owner-only — delete_organization() gates on is_owner and
// cascades every row this tenant owns. requireUser (not requireOrg), same
// reasoning as the 4 routes above: the target org isn't necessarily the
// caller's currently-active one.
app.post('/api/organizations/:id/delete', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('delete_organization', {
    p_organization_id: c.req.valid('param').id,
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.patch('/api/organization', validate('json', updateCurrencyBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client
    .from('organizations')
    .update({ currency: c.req.valid('json').currency })
    .eq('id', auth.organizationId);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/organization/settings', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('organization_settings')
    .select('screen_type, control_size, products_enabled, bookings_enabled')
    .eq('organization_id', auth.organizationId)
    .maybeSingle();
  if (error) return sendPgError(c, error);
  if (!data) {
    return c.json({ screenType: 'guided', controlSize: 'comfortable', productsEnabled: false, bookingsEnabled: true });
  }
  return c.json({
    screenType: data.screen_type,
    controlSize: data.control_size,
    productsEnabled: data.products_enabled,
    bookingsEnabled: data.bookings_enabled,
  });
});

app.patch('/api/organization/settings', validate('json', settingsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { error } = await auth.client.from('organization_settings').upsert(
    {
      organization_id: auth.organizationId,
      ...(body.screenType ? { screen_type: body.screenType } : {}),
      ...(body.controlSize ? { control_size: body.controlSize } : {}),
      ...(body.productsEnabled !== undefined ? { products_enabled: body.productsEnabled } : {}),
      ...(body.bookingsEnabled !== undefined ? { bookings_enabled: body.bookingsEnabled } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' }
  );
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
