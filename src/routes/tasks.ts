import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

// 'active' = pending + in_progress — the working queue's default lens.
const listQuery = z.object({
  status: z.enum(['active', 'pending', 'in_progress', 'done', 'all']).optional().default('active'),
  departmentId: z.string().uuid().optional(),
  // Only tasks with NO department (unassigned) — distinct from omitting the
  // filter entirely.
  unassigned: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional().default(200),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const statusBody = z.object({ status: z.enum(['pending', 'in_progress', 'done']) });

// Everything the queue renders is snapshotted onto the row itself — no joins
// into orders/services, so accounts whose role has ONLY tasks.view still get
// complete cards (orders.view would be denied by RLS on a join).
const SELECT =
  'id, order_id, order_item_id, service_name, customer_name, name, description, department_id, sort_order, status, started_at, completed_at, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    serviceName: row.service_name,
    customerName: row.customer_name,
    name: row.name,
    description: row.description,
    departmentId: row.department_id,
    sortOrder: row.sort_order,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/tasks', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status, departmentId, unassigned, limit, offset } = c.req.valid('query');
  let query = auth.client
    .from('order_tasks')
    .select(SELECT, { count: 'exact' })
    // Newest orders first; inside an order, workflow order. order_id in the
    // middle keeps two orders created in the same second from interleaving.
    .order('created_at', { ascending: false })
    .order('order_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (status === 'active') query = query.in('status', ['pending', 'in_progress']);
  else if (status !== 'all') query = query.eq('status', status);
  if (departmentId) query = query.eq('department_id', departmentId);
  else if (unassigned) query = query.is('department_id', null);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

// Status transitions are unrestricted in either direction (start, complete,
// undo) — the UI nudges sequential flow, the server just records it.
// Timestamps follow the status: entering in_progress stamps started_at
// (first time only), entering done stamps completed_at/completed_by, and
// moving backwards clears what no longer applies.
app.patch('/api/tasks/:id', validate('param', uuidParam), validate('json', statusBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status } = c.req.valid('json');
  const patch: Record<string, any> = { status };
  if (status === 'pending') {
    patch.started_at = null;
    patch.completed_at = null;
    patch.completed_by = null;
  } else if (status === 'in_progress') {
    patch.completed_at = null;
    patch.completed_by = null;
  } else {
    patch.completed_at = new Date().toISOString();
    patch.completed_by = auth.userId;
  }

  // started_at backfills for done-straight-from-pending too, so duration
  // stats stay derivable; COALESCE-style guard is done client-side here by
  // only setting it when currently null — cheaper to just always set it if
  // missing via a second lightweight update path. Fetch-first keeps it one
  // honest read + one write.
  const { data: current, error: readErr } = await auth.client
    .from('order_tasks')
    .select('started_at')
    .eq('id', c.req.valid('param').id)
    .single();
  if (readErr) return sendPgError(c, readErr);
  if (status !== 'pending' && !current.started_at) patch.started_at = new Date().toISOString();

  const { data, error } = await auth.client
    .from('order_tasks')
    .update(patch)
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

export default app;
