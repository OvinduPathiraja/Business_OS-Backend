import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const SORT_FIELDS = ['name', 'price'] as const;
const SORT_COLUMNS: Record<(typeof SORT_FIELDS)[number], string> = { name: 'name', price: 'price' };

const listQuery = paginationQuery.extend({
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional().default('asc'),
});

const serviceBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  price: z.number().min(0).optional(),
  durationOptions: z.array(z.number().positive()).optional(),
  allowsTime: z.boolean().optional(),
  allowsSlot: z.boolean().optional(),
  tint: z.string().optional(),
  icon: z.string().optional(),
  barcode: z.string().optional().nullable(),
});

const SELECT = 'id, organization_id, name, description, price, duration_options, allows_time, allows_slot, tint, icon, barcode';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    durationOptions: (row.duration_options ?? []).map(Number),
    allowsTime: row.allows_time,
    allowsSlot: row.allows_slot,
    tint: row.tint,
    icon: row.icon,
    barcode: row.barcode,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/services', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { search, sort, order, limit, offset } = c.req.valid('query');
  let query = auth.client.from('services').select(SELECT, { count: 'exact' })
    .order(sort ? SORT_COLUMNS[sort] : 'name', { ascending: sort ? order === 'asc' : true });
  // Matches on barcode too so a scanned code (New Order / Services scan
  // flow) surfaces the right row without a separate lookup endpoint.
  if (search) query = query.or(`name.ilike.%${search}%,barcode.ilike.%${search}%`);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

app.post('/api/services', validate('json', serviceBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('services')
    .insert({
      organization_id: auth.organizationId,
      name: b.name,
      description: b.description || null,
      price: b.price ?? 0,
      duration_options: b.durationOptions ?? [],
      allows_time: b.allowsTime ?? true,
      allows_slot: b.allowsSlot ?? true,
      ...(b.tint ? { tint: b.tint } : {}),
      ...(b.icon ? { icon: b.icon } : {}),
      barcode: b.barcode || null,
    })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/services/:id', validate('param', uuidParam), validate('json', serviceBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('services')
    .update({
      name: b.name,
      description: b.description || null,
      price: b.price ?? 0,
      duration_options: b.durationOptions ?? [],
      allows_time: b.allowsTime ?? true,
      allows_slot: b.allowsSlot ?? true,
      ...(b.tint ? { tint: b.tint } : {}),
      ...(b.icon ? { icon: b.icon } : {}),
      barcode: b.barcode || null,
    })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

// ---------------------------------------------------------------------------
// Workflow steps — the ordered task chain a service runs through after an
// order is placed (see supabase/migrations/20260720120000_*.sql).
// ---------------------------------------------------------------------------

const serviceTasksBody = z.object({
  tasks: z.array(
    z.object({
      name: z.string().trim().min(1),
      description: z.string().optional().nullable(),
      departmentId: z.string().uuid().optional().nullable(),
    })
  ),
});

const TASK_SELECT = 'id, service_id, department_id, name, description, sort_order';

app.get('/api/services/:id/tasks', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('service_tasks')
    .select(TASK_SELECT)
    .eq('service_id', c.req.valid('param').id)
    .order('sort_order', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json(
    (data ?? []).map((row: any) => ({
      id: row.id,
      serviceId: row.service_id,
      departmentId: row.department_id,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
    }))
  );
});

// Replaces the whole chain atomically via the set_service_tasks() RPC — the
// flowchart editor saves the full workflow in one call (same pattern as
// set_role_permissions).
app.put('/api/services/:id/tasks', validate('param', uuidParam), validate('json', serviceTasksBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('set_service_tasks', {
    p_service_id: c.req.valid('param').id,
    p_tasks: c.req.valid('json').tasks.map((t) => ({
      name: t.name,
      description: t.description || null,
      departmentId: t.departmentId || null,
    })),
  });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.delete('/api/services', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('services').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
