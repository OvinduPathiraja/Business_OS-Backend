import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

const departmentBody = z.object({
  name: z.string().trim().min(1),
  color: z.string().optional(),
});

const SELECT = 'id, organization_id, name, color';

function fromRow(row: any) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, color: row.color };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/departments', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('departments')
    .select(SELECT)
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(fromRow));
});

app.post('/api/departments', validate('json', departmentBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('departments')
    .insert({
      organization_id: auth.organizationId,
      name: b.name,
      ...(b.color ? { color: b.color } : {}),
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/departments/:id', validate('param', uuidParam), validate('json', departmentBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('departments')
    .update({ name: b.name, ...(b.color ? { color: b.color } : {}) })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

// Members pointing at the deleted department fall back to unassigned
// (department_id is ON DELETE SET NULL), as do workflow steps and any
// queued tasks — nothing blocks the delete.
app.delete('/api/departments/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('departments').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
