import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

const listQuery = z.object({ limit: z.coerce.number().int().positive().max(100).optional().default(30) });

const SELECT = 'id, organization_id, type, title, body, read, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    title: row.title,
    body: row.body,
    read: row.read,
    createdAt: row.created_at,
  };
}

// Only list/mark-read move here — subscribeToNotifications() stays on the
// direct Supabase Realtime client (rebuilding live push through Workers
// would need a Durable Object + WebSocket layer, out of scope for this pass).
const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/notifications', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('notifications')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(c.req.valid('query').limit);
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(fromRow));
});

app.patch('/api/notifications/:id/read', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('notifications').update({ read: true }).eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.patch('/api/notifications/read-all', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client
    .from('notifications')
    .update({ read: true })
    .eq('organization_id', auth.organizationId)
    .eq('read', false);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
