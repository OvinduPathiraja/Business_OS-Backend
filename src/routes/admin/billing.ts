import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { uuidParam } from '../../lib/schemas.js';
import { rangeQuery } from './overview.js';

// Platform billing — what tenants pay US. Every mutating route here requires
// 'billing' rank; the reads are open to any operator including 'analyst'.
//
// Kept rigorously separate from the tenant-facing Finance routes
// (routes/finance.ts, routes/payables.ts). Nothing in this file touches the
// `invoices` / `payments` tables — those are a tenant billing their own
// customers. This file only ever touches `platform_*`.

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
app.get('/api/admin/plans', async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('platform_plans')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) return sendPgError(c, error);

  return c.json(
    (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      tagline: p.tagline,
      priceMonthly: p.price_monthly === null ? null : Number(p.price_monthly),
      priceAnnual: p.price_annual === null ? null : Number(p.price_annual),
      currency: p.currency,
      maxBranches: p.max_branches,
      maxMembers: p.max_members,
      maxOrganizations: p.max_organizations,
      modules: p.modules,
      isActive: p.is_active,
      sortOrder: p.sort_order,
    })),
  );
});

const planBody = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  tagline: z.string().trim().max(200).optional(),
  // null is meaningful and distinct from 0: it renders as "contact us" on the
  // marketing site and contributes nothing to MRR until an amount_override is
  // set on the subscription itself.
  priceMonthly: z.number().min(0).nullable().optional(),
  priceAnnual: z.number().min(0).nullable().optional(),
  currency: z.string().trim().length(3).optional().default('USD'),
  maxBranches: z.number().int().min(0).nullable().optional(),
  maxMembers: z.number().int().min(0).nullable().optional(),
  maxOrganizations: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

app.put('/api/admin/plans', validate('json', planBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'billing');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('upsert_platform_plan', {
    p_code: b.code,
    p_name: b.name,
    p_price_monthly: b.priceMonthly ?? null,
    p_price_annual: b.priceAnnual ?? null,
    p_currency: b.currency,
    p_max_branches: b.maxBranches ?? null,
    p_max_members: b.maxMembers ?? null,
    p_max_organizations: b.maxOrganizations ?? null,
    p_tagline: b.tagline ?? null,
    p_is_active: b.isActive,
  });
  if (error) return sendPgError(c, error);

  return c.json({ id: data });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
app.get('/api/admin/subscriptions', async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client
    .from('platform_subscriptions')
    .select('*, platform_plans(code, name, price_monthly, price_annual)')
    .order('current_period_end', { ascending: true });
  if (error) return sendPgError(c, error);

  // Organization names come from a separate service-client read: organizations
  // is a TENANT table whose RLS scopes it to the caller's own org, so the
  // embedded-join shortcut PostgREST would normally allow returns nothing here.
  const orgIds = [...new Set((data ?? []).map((s: Record<string, unknown>) => s.organization_id as string))];
  const orgNames = await loadOrgNames(auth.svc, orgIds);

  return c.json(
    (data ?? []).map((s: Record<string, unknown>) => {
      const plan = s.platform_plans as Record<string, unknown> | null;
      return {
        id: s.id,
        organizationId: s.organization_id,
        organizationName: orgNames.get(s.organization_id as string) ?? null,
        planCode: plan?.code ?? null,
        planName: plan?.name ?? null,
        status: s.status,
        billingInterval: s.billing_interval,
        amountOverride: s.amount_override === null ? null : Number(s.amount_override),
        currency: s.currency,
        currentPeriodStart: s.current_period_start,
        currentPeriodEnd: s.current_period_end,
        trialEndsAt: s.trial_ends_at,
        cancelledAt: s.cancelled_at,
        notes: s.notes,
      };
    }),
  );
});

const planAssignBody = z.object({
  planCode: z.string().trim().min(1),
  billingInterval: z.enum(['monthly', 'annual']).optional().default('monthly'),
  status: z.enum(['trialing', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
  amountOverride: z.number().min(0).nullable().optional(),
  trialEndsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

app.post(
  '/api/admin/organizations/:id/subscription',
  validate('param', uuidParam),
  validate('json', planAssignBody),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'billing');
    if (auth instanceof Response) return auth;

    const b = c.req.valid('json');
    const { error } = await auth.client.rpc('set_organization_plan', {
      p_organization_id: c.req.valid('param').id,
      p_plan_code: b.planCode,
      p_billing_interval: b.billingInterval,
      p_status: b.status ?? null,
      p_amount_override: b.amountOverride ?? null,
      p_trial_ends_at: b.trialEndsAt ?? null,
      p_notes: b.notes ?? null,
    });
    if (error) return sendPgError(c, error);

    return c.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Invoices, payments, credits
// ---------------------------------------------------------------------------
const invoiceQuery = z.object({
  status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']).optional(),
  organizationId: z.string().uuid().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

app.get('/api/admin/invoices', validate('query', invoiceQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const q = c.req.valid('query');
  let query = auth.client
    .from('platform_invoices')
    .select('*', { count: 'exact' })
    .order('issue_date', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  if (q.status) query = query.eq('status', q.status);
  if (q.organizationId) query = query.eq('organization_id', q.organizationId);
  if (q.overdueOnly) {
    query = query.eq('status', 'open').lt('due_date', new Date().toISOString().slice(0, 10));
  }

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);

  const orgIds = [...new Set((data ?? []).map((i: Record<string, unknown>) => i.organization_id as string))];
  const orgNames = await loadOrgNames(auth.svc, orgIds);

  return c.json({
    total: count ?? 0,
    invoices: (data ?? []).map((i: Record<string, unknown>) => ({
      id: i.id,
      number: i.number,
      organizationId: i.organization_id,
      organizationName: orgNames.get(i.organization_id as string) ?? null,
      status: i.status,
      issueDate: i.issue_date,
      dueDate: i.due_date,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      subtotal: Number(i.subtotal),
      total: Number(i.total),
      amountPaid: Number(i.amount_paid),
      balance: Number(i.total) - Number(i.amount_paid),
      currency: i.currency,
      notes: i.notes,
    })),
  });
});

const createInvoiceBody = z.object({
  organizationId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  advancePeriod: z.boolean().optional().default(true),
});

app.post('/api/admin/invoices', validate('json', createInvoiceBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'billing');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('create_platform_invoice', {
    p_organization_id: b.organizationId,
    p_period_start: b.periodStart ?? null,
    p_period_end: b.periodEnd ?? null,
    p_advance_period: b.advancePeriod,
  });
  if (error) return sendPgError(c, error);

  return c.json({ id: data }, 201);
});

const paymentBody = z.object({
  amount: z.number().positive(),
  method: z.enum(['bank_transfer', 'card', 'cash', 'cheque', 'other']).optional().default('bank_transfer'),
  reference: z.string().trim().max(200).optional(),
  paidAt: z.string().datetime().optional(),
});

app.post(
  '/api/admin/invoices/:id/payments',
  validate('param', uuidParam),
  validate('json', paymentBody),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'billing');
    if (auth instanceof Response) return auth;

    const b = c.req.valid('json');
    const { data, error } = await auth.client.rpc('record_platform_payment', {
      p_invoice_id: c.req.valid('param').id,
      p_amount: b.amount,
      p_method: b.method,
      p_reference: b.reference ?? null,
      p_paid_at: b.paidAt ?? new Date().toISOString(),
    });
    if (error) return sendPgError(c, error);

    return c.json({ id: data }, 201);
  },
);

app.post(
  '/api/admin/invoices/:id/void',
  validate('param', uuidParam),
  validate('json', z.object({ reason: z.string().trim().max(500).optional() })),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'billing');
    if (auth instanceof Response) return auth;

    const { error } = await auth.client.rpc('void_platform_invoice', {
      p_invoice_id: c.req.valid('param').id,
      p_reason: c.req.valid('json').reason ?? null,
    });
    if (error) return sendPgError(c, error);

    return c.json({ ok: true });
  },
);

const creditBody = z.object({
  organizationId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().trim().max(500).optional(),
  invoiceId: z.string().uuid().optional(),
});

app.post('/api/admin/credits', validate('json', creditBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'billing');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { data, error } = await auth.client.rpc('apply_platform_credit', {
    p_organization_id: b.organizationId,
    p_amount: b.amount,
    p_reason: b.reason ?? null,
    p_invoice_id: b.invoiceId ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json({ id: data }, 201);
});

// ---------------------------------------------------------------------------
// Revenue + GMV series. Two different things, on two different screens, for
// the reason spelled out at the top of the metrics migration: revenue is what
// tenants pay us, GMV is what flows through their own tills.
// ---------------------------------------------------------------------------
app.get('/api/admin/revenue', validate('query', rangeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_revenue_series', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(
    ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      day: r.day,
      invoiced: Number(r.invoiced),
      collected: Number(r.collected),
      newMrr: Number(r.new_mrr),
      expansionMrr: Number(r.expansion_mrr),
      contractionMrr: Number(r.contraction_mrr),
      churnedMrr: Number(r.churned_mrr),
    })),
  );
});

app.get('/api/admin/gmv', validate('query', rangeQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_gmv_series', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.json(
    ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      day: r.day,
      currency: r.currency,
      gross: Number(r.gross),
      refunded: Number(r.refunded),
      orderCount: Number(r.order_count),
      // Null (not 0) when no FX rate is on file for that currency — the
      // console renders it as "not converted" rather than as a real zero.
      convertedGross: r.converted_gross === null ? null : Number(r.converted_gross),
    })),
  );
});

// ---------------------------------------------------------------------------
// FX rates
// ---------------------------------------------------------------------------
app.get('/api/admin/fx', async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const [rates, currencies] = await Promise.all([
    auth.client.from('platform_fx_rates').select('*').order('currency'),
    // Which currencies are actually in use, so the console can prompt for a
    // rate the moment a tenant signs up on a currency nobody has set one for.
    auth.svc.from('organizations').select('currency'),
  ]);
  if (rates.error) return sendPgError(c, rates.error);
  if (currencies.error) return sendPgError(c, currencies.error);

  const known = new Set((rates.data ?? []).map((r: Record<string, unknown>) => r.currency as string));
  const inUse = [...new Set((currencies.data ?? []).map((o: Record<string, unknown>) => o.currency as string))];

  return c.json({
    rates: (rates.data ?? []).map((r: Record<string, unknown>) => ({
      currency: r.currency,
      rateToBase: Number(r.rate_to_base),
      baseCurrency: r.base_currency,
      asOf: r.as_of,
    })),
    missing: inUse.filter((cur) => cur && !known.has(cur)),
  });
});

app.put(
  '/api/admin/fx',
  validate('json', z.object({ currency: z.string().trim().length(3), rateToBase: z.number().positive() })),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'billing');
    if (auth instanceof Response) return auth;

    const b = c.req.valid('json');
    const { error } = await auth.client.rpc('set_platform_fx_rate', {
      p_currency: b.currency,
      p_rate: b.rateToBase,
    });
    if (error) return sendPgError(c, error);

    return c.json({ ok: true });
  },
);

// Shared helper — organizations is a tenant table, so cross-tenant name lookup
// has to go through the service client. Batched into one IN query rather than
// one per row.
async function loadOrgNames(
  svc: { from: (t: string) => any },
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data } = await svc.from('organizations').select('id, name').in('id', ids);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
}

export default app;
