import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';

const createOrgBody = z.object({ name: z.string().trim().min(1) });
const updateCurrencyBody = z.object({ currency: z.string().length(3) });
const settingsBody = z.object({
  screenType: z.enum(['guided', 'single', 'compact']).optional(),
  controlSize: z.enum(['comfortable', 'large', 'xlarge']).optional(),
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
    .select('screen_type, control_size')
    .eq('organization_id', auth.organizationId)
    .maybeSingle();
  if (error) return sendPgError(c, error);
  if (!data) {
    return c.json({ screenType: 'guided', controlSize: 'comfortable' });
  }
  return c.json({ screenType: data.screen_type, controlSize: data.control_size });
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
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' }
  );
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
