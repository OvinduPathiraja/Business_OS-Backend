import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const BRANCH_STATUSES = ['active', 'inactive'] as const;

const listQuery = paginationQuery.extend({ status: z.enum(BRANCH_STATUSES).optional() });

const branchBody = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().optional().nullable(),
  status: z.enum(BRANCH_STATUSES).optional(),
});

const SELECT = 'id, organization_id, name, address, status, is_default, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    address: row.address,
    status: row.status,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/branches', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { search, status, limit, offset } = c.req.valid('query');
  let query = auth.client.from('branches').select(SELECT, { count: 'exact' }).order('name', { ascending: true });
  if (search) query = query.ilike('name', `%${search}%`);
  if (status) query = query.eq('status', status);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

app.get('/api/branches/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('branches').select(SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.post('/api/branches', validate('json', branchBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('branches')
    .insert({ organization_id: auth.organizationId, name: b.name, address: b.address || null, status: b.status ?? 'active' })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/branches/:id', validate('param', uuidParam), validate('json', branchBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('branches')
    .update({ name: b.name, address: b.address || null, status: b.status ?? 'active', updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.delete('/api/branches', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('branches').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
