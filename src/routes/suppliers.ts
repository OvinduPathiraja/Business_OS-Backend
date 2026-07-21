import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const SUPPLIER_STATUSES = ['active', 'inactive'] as const;

const listQuery = paginationQuery.extend({ status: z.enum(SUPPLIER_STATUSES).optional() });

const supplierBody = z.object({
  name: z.string().trim().min(1),
  contactName: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
  notes: z.string().optional().nullable(),
});

const SELECT = 'id, organization_id, name, contact_name, email, phone, address, status, notes, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/suppliers', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { search, status, limit, offset } = c.req.valid('query');
  let query = auth.client.from('suppliers').select(SELECT, { count: 'exact' }).order('name', { ascending: true });
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  if (status) query = query.eq('status', status);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

app.get('/api/suppliers/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('suppliers').select(SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.post('/api/suppliers', validate('json', supplierBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('suppliers')
    .insert({
      organization_id: auth.organizationId,
      name: body.name,
      contact_name: body.contactName || null,
      email: body.email || null,
      phone: body.phone || null,
      address: body.address || null,
      status: body.status ?? 'active',
      notes: body.notes || null,
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/suppliers/:id', validate('param', uuidParam), validate('json', supplierBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('suppliers')
    .update({
      name: body.name,
      contact_name: body.contactName || null,
      email: body.email || null,
      phone: body.phone || null,
      address: body.address || null,
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

app.delete('/api/suppliers', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('suppliers').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
