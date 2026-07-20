import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

// The panel palette custom views are assembled from. Adding a panel type
// means: extend this enum + render it in frontend/src/CustomView.tsx.
const PANELS = ['tasks', 'pos', 'orders'] as const;

const configSchema = z.object({
  panels: z.array(z.enum(PANELS)).min(1),
  // 'mine' = tasks for the signed-in worker's own department; 'all' = the
  // whole org's queue.
  taskScope: z.enum(['mine', 'all']).optional().default('mine'),
});

const viewBody = z.object({
  name: z.string().trim().min(1),
  color: z.string().optional(),
  config: configSchema,
});

const SELECT = 'id, organization_id, name, color, config';

function fromRow(row: any) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, color: row.color, config: row.config };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/views', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('org_views')
    .select(SELECT)
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(fromRow));
});

app.post('/api/views', validate('json', viewBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('org_views')
    .insert({
      organization_id: auth.organizationId,
      name: b.name,
      ...(b.color ? { color: b.color } : {}),
      config: b.config,
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/views/:id', validate('param', uuidParam), validate('json', viewBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('org_views')
    .update({ name: b.name, ...(b.color ? { color: b.color } : {}), config: b.config })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

// Roles pointing at the deleted view fall back to no view (roles.view_id is
// ON DELETE SET NULL) — affected restricted accounts land in the built-in
// Cashier View instead, same as before views existed.
app.delete('/api/views/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('org_views').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
