import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

// 'active' = waiting + called — everything still standing in the queue.
const listQuery = z.object({
  status: z.enum(['active', 'waiting', 'called', 'served', 'cancelled', 'all']).optional().default('all'),
  branchId: z.string().uuid().optional(),
  // Only the org-wide "General" sequence (tickets with NO branch) — distinct
  // from omitting the filter entirely.
  general: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional().default(500),
});

// 'cancelled' is deliberately absent: only refund_order() cancels a ticket.
const statusBody = z.object({ status: z.enum(['waiting', 'called', 'served']) });

const SELECT =
  'id, order_id, branch_id, token_date, token_number, customer_name, status, called_at, served_at, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    orderId: row.order_id,
    branchId: row.branch_id,
    tokenDate: row.token_date,
    tokenNumber: row.token_number,
    customerName: row.customer_name,
    status: row.status,
    calledAt: row.called_at,
    servedAt: row.served_at,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// Today's queue only — tokens reset daily, so there is nothing to paginate.
// The response carries the server's date so console/board can ignore realtime
// events from a different day (day rollover) instead of trusting device
// clocks; counters, console, and board all key off this same UTC date.
app.get('/api/queue', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status, branchId, general, limit } = c.req.valid('query');
  const today = new Date().toISOString().slice(0, 10);

  let query = auth.client
    .from('order_tickets')
    .select(SELECT)
    .eq('token_date', today)
    .order('token_number', { ascending: true })
    .limit(limit);

  if (status === 'active') query = query.in('status', ['waiting', 'called']);
  else if (status !== 'all') query = query.eq('status', status);
  if (branchId) query = query.eq('branch_id', branchId);
  else if (general) query = query.is('branch_id', null);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json({ date: today, tickets: (data ?? []).map(fromRow) });
});

// Transitions are unrestricted (call, serve, undo) — the server records,
// the UI nudges. Re-calling a ticket re-stamps called_at, which is what
// brings it back to "now serving" on the board (latest called_at wins).
app.patch('/api/queue/:id', validate('param', uuidParam), validate('json', statusBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { status } = c.req.valid('json');
  const patch: Record<string, any> = { status };
  if (status === 'waiting') {
    patch.called_at = null;
    patch.served_at = null;
  } else if (status === 'called') {
    patch.called_at = new Date().toISOString();
    patch.served_at = null;
  } else {
    patch.served_at = new Date().toISOString();
    // called_at backfills for served-straight-from-waiting so the board's
    // "recently called" history stays complete. Fetch-first, tasks.ts style.
    const { data: current, error: readErr } = await auth.client
      .from('order_tickets')
      .select('called_at')
      .eq('id', c.req.valid('param').id)
      .single();
    if (readErr) return sendPgError(c, readErr);
    if (!current.called_at) patch.called_at = new Date().toISOString();
  }

  const { data, error } = await auth.client
    .from('order_tickets')
    .update(patch)
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

export default app;
