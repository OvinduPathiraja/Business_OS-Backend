import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam } from '../lib/schemas.js';

const printerBody = z.object({ name: z.string().trim().min(1) });

const PRINTER_SELECT = 'id, organization_id, name, connection_type, is_default, created_at';

function printerFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    connectionType: row.connection_type, isDefault: row.is_default, createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/printers', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('printers')
    .select(PRINTER_SELECT)
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(printerFromRow));
});

// connection_type isn't accepted from the client yet — Phase A only ever
// creates 'system' printers (an OS/browser print dialog), so the server
// always inserts the default rather than exposing an unimplemented option.
app.post('/api/printers', validate('json', printerBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('printers')
    .insert({ organization_id: auth.organizationId, name: c.req.valid('json').name })
    .select(PRINTER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(printerFromRow(data), 201);
});

app.patch('/api/printers/:id', validate('param', uuidParam), validate('json', printerBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('printers')
    .update({ name: c.req.valid('json').name, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(PRINTER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(printerFromRow(data));
});

app.delete('/api/printers/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('printers').delete().eq('id', c.req.valid('param').id);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Wraps the set_default_printer() RPC — atomically unsets any other default
// and sets this one, instead of a racy client-side unset-then-set pair.
app.post('/api/printers/:id/default', validate('param', uuidParam), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.rpc('set_default_printer', { p_printer_id: c.req.valid('param').id });
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
