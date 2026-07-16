import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser, requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam, bulkIdsBody, dateRangeQuery } from '../lib/schemas.js';

const TAX_CODE_STATUSES = ['active', 'inactive'] as const;
const APPLIES_TO = ['sales', 'purchases', 'both'] as const;
const FILING_STATUSES = ['draft', 'submitted', 'remitted'] as const;

const taxCodeBody = z.object({
  name: z.string().trim().min(1),
  rate: z.number().min(0),
  appliesTo: z.enum(APPLIES_TO).optional().default('both'),
  status: z.enum(TAX_CODE_STATUSES).optional(),
});

const taxReportQuery = dateRangeQuery.extend({ taxCodeId: z.string().uuid().optional() });

const filingCreateBody = z.object({
  taxCodeId: z.string().uuid().optional().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  taxCollected: z.number(),
  taxPaid: z.number(),
  notes: z.string().optional().nullable(),
});

const filingUpdateBody = z.object({
  status: z.enum(FILING_STATUSES),
  notes: z.string().optional().nullable(),
});

const TAX_CODE_SELECT = 'id, organization_id, name, rate, applies_to, status, created_at';
const FILING_SELECT = 'id, organization_id, tax_code_id, period_start, period_end, tax_collected, tax_paid, net_amount, status, filed_at, notes, created_at';

function taxCodeFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, rate: Number(row.rate),
    appliesTo: row.applies_to, status: row.status, createdAt: row.created_at,
  };
}

function filingFromRow(row: any) {
  return {
    id: row.id, organizationId: row.organization_id, taxCodeId: row.tax_code_id,
    periodStart: row.period_start, periodEnd: row.period_end, taxCollected: Number(row.tax_collected),
    taxPaid: Number(row.tax_paid), netAmount: Number(row.net_amount), status: row.status,
    filedAt: row.filed_at, notes: row.notes, createdAt: row.created_at,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/tax-codes', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('tax_codes').select(TAX_CODE_SELECT).order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(taxCodeFromRow));
});

app.post('/api/tax-codes', validate('json', taxCodeBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('tax_codes')
    .insert({ organization_id: auth.organizationId, name: b.name, rate: b.rate, applies_to: b.appliesTo, status: b.status ?? 'active' })
    .select(TAX_CODE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(taxCodeFromRow(data), 201);
});

app.patch('/api/tax-codes/:id', validate('param', uuidParam), validate('json', taxCodeBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('tax_codes')
    .update({ name: b.name, rate: b.rate, applies_to: b.appliesTo, status: b.status, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(TAX_CODE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(taxCodeFromRow(data));
});

app.delete('/api/tax-codes', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('tax_codes').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

// Tax collected (from paid sales invoices) vs tax paid (from paid bills),
// optionally scoped to one tax code, over an arbitrary period — the input
// a tax_filing is drafted from.
app.get('/api/reports/tax', validate('query', taxReportQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to, taxCodeId } = c.req.valid('query');
  const toDate = `${to}T23:59:59`;

  let invoicesQuery = auth.client.from('invoices').select('tax, tax_code_id, created_at')
    .eq('status', 'paid').gte('created_at', from).lte('created_at', toDate);
  let billsQuery = auth.client.from('bills').select('tax, tax_code_id, created_at')
    .eq('status', 'paid').gte('created_at', from).lte('created_at', toDate);
  if (taxCodeId) {
    invoicesQuery = invoicesQuery.eq('tax_code_id', taxCodeId);
    billsQuery = billsQuery.eq('tax_code_id', taxCodeId);
  }

  const [invoicesRes, billsRes] = await Promise.all([invoicesQuery, billsQuery]);
  if (invoicesRes.error) return sendPgError(c, invoicesRes.error);
  if (billsRes.error) return sendPgError(c, billsRes.error);

  const taxCollected = (invoicesRes.data ?? []).reduce((sum, i: any) => sum + Number(i.tax), 0);
  const taxPaid = (billsRes.data ?? []).reduce((sum, b: any) => sum + Number(b.tax), 0);

  return c.json({ from, to, taxCodeId: taxCodeId ?? null, taxCollected, taxPaid, netAmount: taxCollected - taxPaid });
});

app.get('/api/tax-filings', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('tax_filings').select(FILING_SELECT).order('period_start', { ascending: false });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(filingFromRow));
});

app.post('/api/tax-filings', validate('json', filingCreateBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('tax_filings')
    .insert({
      organization_id: auth.organizationId, tax_code_id: b.taxCodeId || null,
      period_start: b.periodStart, period_end: b.periodEnd, tax_collected: b.taxCollected,
      tax_paid: b.taxPaid, net_amount: b.taxCollected - b.taxPaid, notes: b.notes || null,
    })
    .select(FILING_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(filingFromRow(data), 201);
});

app.patch('/api/tax-filings/:id', validate('param', uuidParam), validate('json', filingUpdateBody), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client
    .from('tax_filings')
    .update({
      status: b.status, notes: b.notes || null,
      filed_at: b.status === 'draft' ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', c.req.valid('param').id)
    .select(FILING_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(filingFromRow(data));
});

export default app;
