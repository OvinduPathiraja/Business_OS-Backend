import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, optionalDateRangeQuery } from '../lib/schemas.js';

const ACTIONS = ['insert', 'update', 'delete'] as const;
const SORT_FIELDS = ['action', 'tableName', 'createdAt'] as const;
const SORT_COLUMNS: Record<(typeof SORT_FIELDS)[number], string> = {
  action: 'action', tableName: 'table_name', createdAt: 'created_at',
};

const listQuery = paginationQuery.extend({
  action: z.enum(ACTIONS).optional(),
  module: z.string().trim().min(1).optional(),
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
}).extend(optionalDateRangeQuery.shape);

// Rows are written exclusively by the log_activity() trigger (see
// 20260712100000_activity_log.sql) — this route only ever reads.
const SELECT = 'id, action, table_name, record_id, summary, created_at, profiles(full_name)';

function fromRow(row: any) {
  const actor = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return {
    id: row.id,
    action: row.action,
    tableName: row.table_name,
    recordId: row.record_id,
    summary: row.summary,
    actorName: actor?.full_name ?? null,
    createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/activity', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { action, module, sort, order, from, to, limit, offset } = c.req.valid('query');
  let query = auth.client
    .from('activity_log')
    .select(SELECT, { count: 'exact' })
    .order(sort ? SORT_COLUMNS[sort] : 'created_at', { ascending: sort ? order === 'asc' : false });
  if (action) query = query.eq('action', action);
  if (module) query = query.eq('table_name', module);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', `${to}T23:59:59`);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

export default app;
