import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam, bulkIdsBody, optionalDateRangeQuery } from '../lib/schemas.js';

const ENTRY_DIRECTIONS = ['credit', 'debit'] as const;

const ledgerBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional().nullable(),
});

const entryCreateBody = z.object({
  direction: z.enum(ENTRY_DIRECTIONS),
  amount: z.number().positive(),
  description: z.string().trim().optional().nullable(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const LEDGER_SELECT = 'id, organization_id, name, description, created_at';
const ENTRY_SELECT = 'id, organization_id, ledger_id, direction, amount, description, entry_date, created_by, created_at';

function entryFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, ledgerId: row.ledger_id, direction: row.direction,
    amount: Number(row.amount), description: row.description, entryDate: row.entry_date,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// Returns each ledger with its running totals (money in / money out / net)
// aggregated server-side — the list view needs balances without fetching
// every entry of every ledger into the client.
app.get('/api/ledgers', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const [ledgersRes, entriesRes] = await Promise.all([
    auth.client.from('ledgers').select(LEDGER_SELECT).order('name', { ascending: true }),
    auth.client.from('ledger_entries').select('ledger_id, direction, amount'),
  ]);
  if (ledgersRes.error) return sendPgError(c, ledgersRes.error);
  if (entriesRes.error) return sendPgError(c, entriesRes.error);

  const totals = new Map<string, { count: number; moneyIn: number; moneyOut: number }>();
  (entriesRes.data ?? []).forEach((e: any) => {
    const t = totals.get(e.ledger_id) ?? { count: 0, moneyIn: 0, moneyOut: 0 };
    t.count += 1;
    if (e.direction === 'credit') t.moneyIn += Number(e.amount);
    else t.moneyOut += Number(e.amount);
    totals.set(e.ledger_id, t);
  });

  return c.json((ledgersRes.data ?? []).map((row: any) => {
    const t = totals.get(row.id) ?? { count: 0, moneyIn: 0, moneyOut: 0 };
    return {
      id: row.id, organizationId: row.organization_id, name: row.name, description: row.description,
      createdAt: row.created_at, entryCount: t.count, moneyIn: t.moneyIn, moneyOut: t.moneyOut,
      net: t.moneyIn - t.moneyOut,
    };
  }));
});

app.post('/api/ledgers', validate('json', ledgerBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('ledgers')
    .insert({ organization_id: auth.organizationId, name: b.name, description: b.description || null })
    .select(LEDGER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json({
    id: data.id, organizationId: data.organization_id, name: data.name, description: data.description,
    createdAt: data.created_at, entryCount: 0, moneyIn: 0, moneyOut: 0, net: 0,
  }, 201);
});

app.patch('/api/ledgers/:id', validate('param', uuidParam), validate('json', ledgerBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('ledgers')
    .update({ name: b.name, description: b.description || null, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(LEDGER_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json({ id: data.id, organizationId: data.organization_id, name: data.name, description: data.description, createdAt: data.created_at });
});

app.delete('/api/ledgers', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('ledgers').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/ledgers/:id/entries', validate('param', uuidParam), validate('query', optionalDateRangeQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  let query = auth.client.from('ledger_entries').select(ENTRY_SELECT)
    .eq('ledger_id', c.req.valid('param').id)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (from) query = query.gte('entry_date', from);
  if (to) query = query.lte('entry_date', to);

  const { data, error } = await query;
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(entryFromRow));
});

app.post('/api/ledgers/:id/entries', validate('param', uuidParam), validate('json', entryCreateBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('ledger_entries')
    .insert({
      organization_id: auth.organizationId, ledger_id: c.req.valid('param').id,
      direction: b.direction, amount: b.amount, description: b.description || null,
      ...(b.entryDate ? { entry_date: b.entryDate } : {}),
      created_by: auth.userId,
    })
    .select(ENTRY_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(entryFromRow(data), 201);
});

app.delete('/api/ledger-entries', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('ledger_entries').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
