import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, optionalDateRangeQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const CUSTOMER_STATUSES = ['active', 'inactive', 'blacklisted'] as const;
const SORT_FIELDS = ['name', 'email', 'status', 'createdAt'] as const;
const SORT_COLUMNS: Record<(typeof SORT_FIELDS)[number], string> = {
  name: 'name', email: 'email', status: 'status', createdAt: 'created_at',
};

const listQuery = paginationQuery.extend({
  status: z.enum(CUSTOMER_STATUSES).optional(),
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
}).extend(optionalDateRangeQuery.shape);

const customerBody = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  notes: z.string().optional().nullable(),
});

const SELECT = 'id, organization_id, name, email, phone, status, notes, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/customers', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { search, status, sort, order, from, to, limit, offset } = c.req.valid('query');
  let query = auth.client.from('customers').select(SELECT, { count: 'exact' })
    .order(sort ? SORT_COLUMNS[sort] : 'created_at', { ascending: sort ? order === 'asc' : false });
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  if (status) query = query.eq('status', status);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', `${to}T23:59:59`);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

app.get('/api/customers/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('customers').select(SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.post('/api/customers', validate('json', customerBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('customers')
    .insert({
      organization_id: auth.organizationId,
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      status: body.status ?? 'active',
      notes: body.notes || null,
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/customers/:id', validate('param', uuidParam), validate('json', customerBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('customers')
    .update({
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      status: body.status,
      notes: body.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.delete('/api/customers', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('customers').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
