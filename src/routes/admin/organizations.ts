import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { uuidParam } from '../../lib/schemas.js';

const app = new Hono<{ Bindings: Bindings }>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirrors platform_org_directory()'s signature. Everything is optional — the
// console builds this up from filter chips, and an empty query means "all
// tenants, newest first".
const directoryQuery = z.object({
  search: z.string().trim().max(200).optional(),
  plan: z.string().trim().max(50).optional(),
  subscriptionStatus: z.enum(['trialing', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
  orgStatus: z.enum(['active', 'suspended', 'archived']).optional(),
  currency: z.string().trim().length(3).optional(),
  createdFrom: z.string().regex(DATE_RE).optional(),
  createdTo: z.string().regex(DATE_RE).optional(),
  minGmv: z.coerce.number().min(0).optional(),
  activeSince: z.string().regex(DATE_RE).optional(),
  // Constrained to the set platform_org_directory() actually branches on, so
  // an unknown value can't silently fall through to an arbitrary ordering.
  sort: z.enum(['created_at', 'name', 'gmv', 'mrr', 'members', 'orders', 'last_activity'])
    .optional().default('created_at'),
  dir: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

app.get('/api/admin/organizations', validate('query', directoryQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const q = c.req.valid('query');
  const { data, error } = await auth.client.rpc('platform_org_directory', {
    p_search: q.search ?? null,
    p_plan_code: q.plan ?? null,
    p_subscription_status: q.subscriptionStatus ?? null,
    p_org_status: q.orgStatus ?? null,
    p_currency: q.currency ?? null,
    p_created_from: q.createdFrom ?? null,
    p_created_to: q.createdTo ?? null,
    p_min_gmv: q.minGmv ?? null,
    p_active_since: q.activeSince ?? null,
    p_sort: q.sort,
    p_dir: q.dir,
    p_limit: q.limit,
    p_offset: q.offset,
  });
  if (error) return sendPgError(c, error);

  const rows = (data ?? []) as Record<string, unknown>[];
  // total_count is the same on every row (a window function over the filtered
  // set), so the pager gets its count without a second query. Zero rows
  // legitimately means zero matches.
  const total = rows.length ? Number(rows[0].total_count) : 0;

  return c.json({
    total,
    limit: q.limit,
    offset: q.offset,
    organizations: rows.map((r) => ({
      id: r.organization_id,
      name: r.name,
      slug: r.slug,
      currency: r.currency,
      logoUrl: r.logo_url,
      status: r.org_status,
      suspendedReason: r.suspended_reason,
      createdAt: r.created_at,
      ownerName: r.owner_name,
      ownerEmail: r.owner_email,
      planCode: r.plan_code,
      planName: r.plan_name,
      subscriptionStatus: r.subscription_status,
      billingInterval: r.billing_interval,
      trialEndsAt: r.trial_ends_at,
      mrr: Number(r.mrr ?? 0),
      activeMembers: Number(r.active_members ?? 0),
      totalMembers: Number(r.total_members ?? 0),
      branches: Number(r.branches ?? 0),
      ordersCount: Number(r.orders_count ?? 0),
      gmv: Number(r.gmv ?? 0),
      outstanding: Number(r.outstanding ?? 0),
      lastActivityAt: r.last_activity_at,
      modules: r.modules,
    })),
  });
});

app.get('/api/admin/organizations/:id', validate('param', uuidParam), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const organizationId = c.req.valid('param').id;

  // Two RPCs rather than one. platform_org_detail() is a large function that
  // several screens depend on, and the lifecycle dates + grace window this
  // console now needs live in organization_access_state() — which is also
  // what the gate and the tenant's own billing screen read, so merging it
  // here means the console can never show a different answer to the one being
  // enforced. Copying platform_org_detail() forward to add four fields would
  // have been the other option, and it is the riskier one: that function is
  // ~150 lines and is not owned by this feature.
  //
  // This is a single-organization drawer, not a hot path — one extra round
  // trip is the cheaper side of the trade.
  const [detailResult, accessResult] = await Promise.all([
    auth.client.rpc('platform_org_detail', { p_organization_id: organizationId }),
    auth.client.rpc('organization_access_state', { p_organization_id: organizationId }),
  ]);

  if (detailResult.error) return sendPgError(c, detailResult.error);
  const data = detailResult.data as { organization?: unknown; subscription?: Record<string, unknown> | null } | null;
  if (!data || !data.organization) {
    return c.json({ error: 'Organization not found.' }, 404);
  }

  // Non-fatal, and null-safe: an organization with no subscription row gets
  // null from the RPC, and the drawer already handles a null subscription.
  const access = accessResult.error ? null : (accessResult.data as Record<string, unknown> | null);
  if (access && data.subscription) {
    data.subscription = { ...data.subscription, ...access };
  }

  return c.json(data);
});

// Suspend / reactivate. superadmin only, enforced BOTH here and inside
// set_organization_status(). The RPC writes its own audit row and its own
// subscription event, so this handler deliberately adds nothing beyond calling
// it — one writer, one story.
const statusBody = z.object({
  status: z.enum(['active', 'suspended', 'archived']),
  reason: z.string().trim().max(500).optional(),
});

app.post(
  '/api/admin/organizations/:id/status',
  validate('param', uuidParam),
  validate('json', statusBody),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'superadmin');
    if (auth instanceof Response) return auth;

    const { status, reason } = c.req.valid('json');
    const { error } = await auth.client.rpc('set_organization_status', {
      p_organization_id: c.req.valid('param').id,
      p_status: status,
      p_reason: reason ?? null,
    });
    if (error) return sendPgError(c, error);

    return c.json({ ok: true, status });
  },
);

export default app;
