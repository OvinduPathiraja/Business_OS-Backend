import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';

const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer', 'wallet'] as const;
const SCOPES = ['order', 'items'] as const;
const REWARD_TYPES = ['percent', 'fixed', 'buy_x_get_y'] as const;
const CARD_TYPE_STATUSES = ['active', 'inactive'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const targetSchema = z.object({
  serviceId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
}).refine((t) => Boolean(t.serviceId) !== Boolean(t.variantId), {
  message: 'Each target must have exactly one of serviceId or variantId.',
});

// Mirrors the DB check constraints (promotions_reward_shape etc.) so a
// misconfigured promotion is a 400, not a raw Postgres check violation.
const promotionBody = z.object({
  name: z.string().trim().min(1),
  scope: z.enum(SCOPES),
  rewardType: z.enum(REWARD_TYPES),
  percentOff: z.number().gt(0).max(100).optional().nullable(),
  amountOff: z.number().gt(0).optional().nullable(),
  buyQty: z.number().int().min(1).optional().nullable(),
  getQty: z.number().int().min(1).optional().nullable(),
  startsOn: isoDate.optional().nullable(),
  endsOn: isoDate.optional().nullable(),
  minQty: z.number().int().min(1).optional().nullable(),
  minSubtotal: z.number().min(0).optional().nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional().nullable(),
  cardTypeId: z.string().uuid().optional().nullable(),
  active: z.boolean().optional(),
  targets: z.array(targetSchema).optional(),
}).superRefine((b, ctx) => {
  if (b.rewardType === 'percent' && b.percentOff == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'percentOff is required for a percentage promotion.' });
  }
  if (b.rewardType === 'fixed' && b.amountOff == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amountOff is required for a fixed-amount promotion.' });
  }
  if (b.rewardType === 'buy_x_get_y') {
    if (b.buyQty == null || b.getQty == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'buyQty and getQty are required for a buy-X-get-Y promotion.' });
    }
    if (b.scope !== 'items') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Buy X get Y promotions must target specific items.' });
    }
  }
  if (b.scope === 'items' && (!b.targets || b.targets.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An items promotion needs at least one target service or product.' });
  }
  if (b.cardTypeId && b.paymentMethod !== 'card') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A card-specific promotion must have payment method "card".' });
  }
  if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End date must not be before start date.' });
  }
});

const cardTypeBody = z.object({
  name: z.string().trim().min(1),
  status: z.enum(CARD_TYPE_STATUSES).optional(),
});

const listQuery = paginationQuery.extend({ active: z.enum(['true', 'false']).optional() });
// The checkout passes its local calendar date — the Worker runs in UTC and
// the two can disagree around midnight; the client's day is the one the
// promotion terms mean. The engine re-checks dates client-side regardless.
const activeQuery = z.object({ date: isoDate.optional() });

const SELECT =
  'id, organization_id, name, scope, reward_type, percent_off, amount_off, buy_qty, get_qty, ' +
  'starts_on, ends_on, min_qty, min_subtotal, payment_method, card_type_id, active, created_at, ' +
  'promotion_targets(service_id, variant_id)';

const CARD_TYPE_SELECT = 'id, organization_id, name, status, created_at';

function fromRow(row: any) {
  const targets: any[] = Array.isArray(row.promotion_targets) ? row.promotion_targets : [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    scope: row.scope,
    rewardType: row.reward_type,
    percentOff: row.percent_off == null ? null : Number(row.percent_off),
    amountOff: row.amount_off == null ? null : Number(row.amount_off),
    buyQty: row.buy_qty == null ? null : Number(row.buy_qty),
    getQty: row.get_qty == null ? null : Number(row.get_qty),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    minQty: row.min_qty == null ? null : Number(row.min_qty),
    minSubtotal: row.min_subtotal == null ? null : Number(row.min_subtotal),
    paymentMethod: row.payment_method,
    cardTypeId: row.card_type_id,
    active: row.active,
    createdAt: row.created_at,
    targets: targets.map((t) => ({ serviceId: t.service_id, variantId: t.variant_id })),
  };
}

function cardTypeFromRow(row: any) {
  return { id: row.id, organizationId: row.organization_id, name: row.name, status: row.status, createdAt: row.created_at };
}

// Normalize to the exact column shape the DB constraints allow: only the
// fields this reward type / scope uses are kept, everything else is null —
// so a form that switched reward types mid-edit can never produce a row the
// promotions_reward_shape constraint rejects.
function toRow(b: z.infer<typeof promotionBody>) {
  const bxgy = b.rewardType === 'buy_x_get_y';
  return {
    name: b.name,
    scope: b.scope,
    reward_type: b.rewardType,
    percent_off: b.rewardType === 'percent' ? b.percentOff : null,
    amount_off: b.rewardType === 'fixed' ? b.amountOff : null,
    buy_qty: bxgy ? b.buyQty : null,
    get_qty: bxgy ? b.getQty : null,
    starts_on: b.startsOn || null,
    ends_on: b.endsOn || null,
    min_qty: b.scope === 'items' && !bxgy ? b.minQty ?? null : null,
    min_subtotal: b.scope === 'order' ? b.minSubtotal ?? null : null,
    payment_method: b.paymentMethod || null,
    card_type_id: b.paymentMethod === 'card' ? b.cardTypeId || null : null,
    active: b.active ?? true,
  };
}

async function replaceTargets(client: any, organizationId: string, promotionId: string, b: z.infer<typeof promotionBody>) {
  const del = await client.from('promotion_targets').delete().eq('promotion_id', promotionId);
  if (del.error) return del.error;
  if (b.scope !== 'items' || !b.targets?.length) return null;
  const ins = await client.from('promotion_targets').insert(
    b.targets.map((t) => ({
      organization_id: organizationId,
      promotion_id: promotionId,
      service_id: t.serviceId ?? null,
      variant_id: t.variantId ?? null,
    }))
  );
  return ins.error;
}

const app = new Hono<{ Bindings: Bindings }>();

// Literal paths registered before /api/promotions/:id so :id can't swallow them.

// Checkout read path — every currently-valid promotion, with targets, in one
// call. Readable by any role with promotions.view (RLS), which includes
// staff and cashier.
app.get('/api/promotions/active', validate('query', activeQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const today = c.req.valid('query').date ?? new Date().toISOString().slice(0, 10);
  const { data, error } = await auth.client
    .from('promotions')
    .select(SELECT)
    .eq('active', true)
    .or(`starts_on.is.null,starts_on.lte.${today}`)
    .or(`ends_on.is.null,ends_on.gte.${today}`)
    .order('created_at', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(fromRow));
});

app.get('/api/promotions/card-types', async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('promotion_card_types')
    .select(CARD_TYPE_SELECT)
    .order('name', { ascending: true });
  if (error) return sendPgError(c, error);
  return c.json((data ?? []).map(cardTypeFromRow));
});

app.post('/api/promotions/card-types', validate('json', cardTypeBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('promotion_card_types')
    .insert({ organization_id: auth.organizationId, name: body.name, status: body.status ?? 'active' })
    .select(CARD_TYPE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(cardTypeFromRow(data), 201);
});

app.patch('/api/promotions/card-types/:id', validate('param', uuidParam), validate('json', cardTypeBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('promotion_card_types')
    .update({ name: body.name, status: body.status, updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(CARD_TYPE_SELECT)
    .single();
  if (error) return sendPgError(c, error);
  return c.json(cardTypeFromRow(data));
});

app.delete('/api/promotions/card-types', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('promotion_card_types').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

app.get('/api/promotions', validate('query', listQuery), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { search, active, limit, offset } = c.req.valid('query');
  let query = auth.client.from('promotions').select(SELECT, { count: 'exact' }).order('created_at', { ascending: false });
  if (search) query = query.ilike('name', `%${search}%`);
  if (active) query = query.eq('active', active === 'true');
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);
  c.header('X-Total-Count', String(count ?? 0));
  return c.json((data ?? []).map(fromRow));
});

app.get('/api/promotions/:id', validate('param', uuidParam), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.from('promotions').select(SELECT).eq('id', c.req.valid('param').id).single();
  if (error) return sendPgError(c, error);
  return c.json(fromRow(data));
});

app.post('/api/promotions', validate('json', promotionBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('promotions')
    .insert({ organization_id: auth.organizationId, ...toRow(body) })
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  const row: any = data;

  const targetsError = await replaceTargets(auth.client, auth.organizationId, row.id, body);
  if (targetsError) return sendPgError(c, targetsError);

  return c.json(fromRow({ ...row, promotion_targets: (body.targets ?? []).map((t) => ({ service_id: t.serviceId ?? null, variant_id: t.variantId ?? null })) }), 201);
});

app.patch('/api/promotions/:id', validate('param', uuidParam), validate('json', promotionBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const body = c.req.valid('json');
  const { data, error } = await auth.client
    .from('promotions')
    .update({ ...toRow(body), updated_at: new Date().toISOString() })
    .eq('id', c.req.valid('param').id)
    .select(SELECT)
    .single();
  if (error) return sendPgError(c, error);
  const row: any = data;

  const targetsError = await replaceTargets(auth.client, auth.organizationId, row.id, body);
  if (targetsError) return sendPgError(c, targetsError);

  return c.json(fromRow({ ...row, promotion_targets: (body.scope === 'items' ? body.targets ?? [] : []).map((t) => ({ service_id: t.serviceId ?? null, variant_id: t.variantId ?? null })) }));
});

app.delete('/api/promotions', validate('json', bulkIdsBody), async (c) => {
  const auth = await requireOrg(c);
  if (auth instanceof Response) return auth;

  const { error } = await auth.client.from('promotions').delete().in('id', c.req.valid('json').ids);
  if (error) return sendPgError(c, error);
  return c.body(null, 204);
});

export default app;
