import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';

// The platform audit log — every mutating operator action, from suspending a
// tenant to changing what they're charged to signing in as one of their staff.
// Read-only by construction: there is no write route here, because everything
// that belongs in this table is written by the RPC that performed the action,
// inside the same transaction as the action itself.

const app = new Hono<{ Bindings: Bindings }>();

const auditQuery = z.object({
  action: z.string().trim().max(100).optional(),
  actorUserId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

app.get('/api/admin/audit', validate('query', auditQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const q = c.req.valid('query');
  let query = auth.client
    .from('platform_audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  // Prefix match, so 'invoice' matches invoice.create / invoice.payment /
  // invoice.void without the console needing to know the full action list.
  if (q.action) query = query.like('action', `${q.action}%`);
  if (q.actorUserId) query = query.eq('actor_user_id', q.actorUserId);
  if (q.organizationId) query = query.eq('organization_id', q.organizationId);
  if (q.from) query = query.gte('created_at', `${q.from}T00:00:00Z`);
  if (q.to) query = query.lt('created_at', `${q.to}T23:59:59.999Z`);

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);

  const rows = (data ?? []) as Record<string, unknown>[];
  const actorIds = [...new Set(rows.map((r) => r.actor_user_id as string))].filter(Boolean);
  const orgIds = [...new Set(rows.map((r) => r.organization_id as string))].filter(Boolean);

  const [actors, orgs] = await Promise.all([
    actorIds.length
      ? auth.svc.from('profiles').select('id, full_name, email').in('id', actorIds)
      : Promise.resolve({ data: [] }),
    orgIds.length
      ? auth.svc.from('organizations').select('id, name').in('id', orgIds)
      : Promise.resolve({ data: [] }),
  ]);

  const actorOf = new Map(
    ((actors.data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map(
      (p) => [p.id, p.full_name ?? p.email ?? null],
    ),
  );
  const orgOf = new Map(((orgs.data ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));

  return c.json({
    total: count ?? 0,
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorUserId: r.actor_user_id,
      actorName: actorOf.get(r.actor_user_id as string) ?? null,
      targetType: r.target_type,
      targetId: r.target_id,
      organizationId: r.organization_id,
      organizationName: orgOf.get(r.organization_id as string) ?? null,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  });
});

export default app;
