import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

// Order-level sign-off. One row per order (see spawn_order_completion() in
// supabase/migrations/20260726020000_*.sql), created at checkout only when a
// service on the order asks to be reviewed.
//
// 'ready' = pending AND every workflow step done — is_ready is a stored
// generated column (done_tasks >= total_tasks) precisely because PostgREST
// can't compare two columns in a query string.
const listQuery = z.object({
  status: z.enum(['pending', 'completed', 'all']).optional().default('pending'),
  ready: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional().default(200),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const completeBody = z.object({ notes: z.string().optional().nullable() });

// Everything the card renders is snapshotted onto the row itself (customer/
// service names) or maintained by the order_tasks trigger (the counters), so
// a role with ONLY completions.view gets a complete card — it can read
// neither orders nor order_tasks, and any join here would be RLS-denied.
const SELECT =
  'id, order_id, customer_name, service_names, reviewer_department_id, instructions, total_tasks, done_tasks, is_ready, status, completed_at, completed_by, notes, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    orderId: row.order_id,
    customerName: row.customer_name,
    serviceNames: row.service_names,
    reviewerDepartmentId: row.reviewer_department_id,
    instructions: row.instructions,
    totalTasks: row.total_tasks,
    doneTasks: row.done_tasks,
    isReady: row.is_ready,
    status: row.status,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/completions', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status, ready, limit, offset } = c.req.valid('query');
  let query = auth.client
    .from('order_completions')
    .select(SELECT, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (status !== 'all') query = query.eq('status', status);
  // Only meaningful alongside a pending filter — a completed order is ready
  // by definition — but harmless if combined with 'all'.
  if (ready !== undefined) query = query.eq('is_ready', ready);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

// A narrow, one-way action rather than a general PATCH — the same shape as
// POST /api/tasks/:id/finalize. Every field except the optional note is
// server-set, and the conditional update mirrors the completions.finalize RLS
// policy (pending rows only), so a double-submit from two tabs 409s instead
// of overwriting the first reviewer's signature.
app.post('/api/completions/:id/complete', validate('param', uuidParam), validate('json', completeBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { id } = c.req.valid('param');

  // Readiness is enforced here, not in the update's filter chain, so the
  // caller gets "the work isn't finished" instead of a blanket 409 that
  // can't distinguish it from "already signed off".
  const { data: current, error: readErr } = await auth.client
    .from('order_completions')
    .select('is_ready, status, done_tasks, total_tasks')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return sendPgError(c, readErr);
  if (!current) return c.json({ error: 'Order completion not found.' }, 404);
  if (!current.is_ready) {
    return c.json(
      { error: `This order still has work in progress (${current.done_tasks}/${current.total_tasks} steps done).` },
      409
    );
  }

  const { data, error } = await auth.client
    .from('order_completions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: auth.userId,
      notes: c.req.valid('json').notes || null,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select(SELECT)
    .maybeSingle();
  if (error) return sendPgError(c, error);
  if (!data) return c.json({ error: 'This order has already been signed off.' }, 409);
  return c.json(fromRow(data));
});

export default app;
