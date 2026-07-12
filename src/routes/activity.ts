import { Hono } from 'hono';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery } from '../lib/schemas.js';

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

app.get('/api/activity', validate('query', paginationQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { limit, offset } = c.req.valid('query');
  const { data, error, count } = await auth.client
    .from('activity_log')
    .select(SELECT, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

export default app;
