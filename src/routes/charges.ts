import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { uuidParam, bulkIdsBody } from '../lib/schemas.js';

// Org-defined extra charges (service charge, delivery, …) applied at
// checkout on top of the items — the mirror image of promotions. The
// catalog is small (like promotion card types), so list/create/update/
// delete with no pagination; the checkout filters `active` client-side.

// Mirrors the DB check constraints (charge_types_percent_needs_value etc.)
// so a misconfigured charge is a 400, not a raw Postgres check violation.
const chargeTypeBody = z.object({
  name: z.string().trim().min(1),
  calcType: z.enum(['percent', 'fixed']),
  // percent: the percentage (1..100). fixed: the amount, or null = the
  // cashier enters the amount at checkout.
  value: z.number().gt(0).optional().nullable(),
  autoApply: z.boolean().optional(),
  taxable: z.boolean().optional(),
  active: z.boolean().optional(),
}).superRefine((b, ctx) => {
  if (b.calcType === 'percent' && (b.value == null || b.value > 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A percentage charge needs a percentage between 1 and 100.' });
  }
  if (b.autoApply && b.value == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An auto-applied charge needs a stored amount.' });
  }
});

const SELECT = 'id, organization_id, name, calc_type, value, auto_apply, taxable, active, created_at';

function fromRow(row: any) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    calcType: row.calc_type,
    value: row.value == null ? null : Number(row.value),
    autoApply: row.auto_apply,
    taxable: row.taxable,
    active: row.active,
    createdAt: row.created_at,
  };
}

function toRow(b: z.infer<typeof chargeTypeBody>) {
  return {
    name: b.name,
    calc_type: b.calcType,
    value: b.value ?? null,
    auto_apply: b.autoApply ?? false,
    taxable: b.taxable ?? false,
    active: b.active ?? true,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/charges', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('charge_types')
    .select(SELECT)
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(fromRow));
});

app.post('/api/charges', validate('json', chargeTypeBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('charge_types')
    .insert({ organization_id: auth.organizationId, ...toRow(c.req.valid('json')) })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data), 201);
});

app.patch('/api/charges/:id', validate('param', uuidParam), validate('json', chargeTypeBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('charge_types')
    .update({ ...toRow(c.req.valid('json')), updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.delete('/api/charges', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('charge_types').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
