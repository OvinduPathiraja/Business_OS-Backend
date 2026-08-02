import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { uuidParam } from '../../lib/schemas.js';

// Triage for submissions from the marketing site's contact form. The public
// write path is in routes/public/inquiries.ts — this file is the operator side
// only, and requires 'support' rank for anything that mutates.

const app = new Hono<{ Bindings: Bindings }>();

const listQuery = z.object({
  status: z.enum(['new', 'open', 'waiting', 'closed', 'spam']).optional(),
  assignedTo: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

app.get('/api/admin/inquiries', validate('query', listQuery), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const q = c.req.valid('query');
  let query = auth.client
    .from('platform_inquiries')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  if (q.status) query = query.eq('status', q.status);
  if (q.assignedTo) query = query.eq('assigned_to', q.assignedTo);
  if (q.search) {
    query = query.or(
      `name.ilike.%${q.search}%,email.ilike.%${q.search}%,company.ilike.%${q.search}%,message.ilike.%${q.search}%`,
    );
  }

  const { data, error, count } = await query;
  if (error) return sendPgError(c, error);

  // Counts for the status filter chips, so the inbox can show "New (4)"
  // without the client fetching every page to work it out.
  const { data: allStatuses } = await auth.client.from('platform_inquiries').select('status');
  const counts: Record<string, number> = {};
  for (const row of (allStatuses ?? []) as { status: string }[]) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }

  return c.json({
    total: count ?? 0,
    counts,
    inquiries: (data ?? []).map(mapInquiry),
  });
});

app.get('/api/admin/inquiries/:id', validate('param', uuidParam), async (c) => {
  const auth = await requirePlatformAdmin(c);
  if (auth instanceof Response) return auth;

  const id = c.req.valid('param').id;
  const [inquiryRes, notesRes] = await Promise.all([
    auth.client.from('platform_inquiries').select('*').eq('id', id).single(),
    auth.svc
      .from('platform_inquiry_notes')
      .select('id, body, created_at, author_user_id, profiles(full_name, email)')
      .eq('inquiry_id', id)
      .order('created_at', { ascending: true }),
  ]);
  if (inquiryRes.error) return sendPgError(c, inquiryRes.error);
  if (notesRes.error) return sendPgError(c, notesRes.error);

  return c.json({
    ...mapInquiry(inquiryRes.data as Record<string, unknown>),
    notes: (notesRes.data ?? []).map((n: Record<string, unknown>) => {
      const p = n.profiles as { full_name?: string; email?: string } | null;
      return {
        id: n.id,
        body: n.body,
        createdAt: n.created_at,
        authorName: p?.full_name ?? p?.email ?? null,
      };
    }),
  });
});

const updateBody = z.object({
  status: z.enum(['new', 'open', 'waiting', 'closed', 'spam']).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  organizationId: z.string().uuid().optional(),
});

app.patch(
  '/api/admin/inquiries/:id',
  validate('param', uuidParam),
  validate('json', updateBody),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'support');
    if (auth instanceof Response) return auth;

    const b = c.req.valid('json');
    const { error } = await auth.client.rpc('update_inquiry', {
      p_inquiry_id: c.req.valid('param').id,
      p_status: b.status ?? null,
      p_priority: b.priority ?? null,
      p_assigned_to: b.assignedTo ?? null,
      p_organization_id: b.organizationId ?? null,
      // Explicit null means "unassign", which coalesce() alone can't express —
      // hence the separate flag rather than overloading p_assigned_to.
      p_clear_assignee: b.assignedTo === null,
    });
    if (error) return sendPgError(c, error);

    return c.json({ ok: true });
  },
);

app.post(
  '/api/admin/inquiries/:id/notes',
  validate('param', uuidParam),
  validate('json', z.object({ body: z.string().trim().min(1).max(5000) })),
  async (c) => {
    const auth = await requirePlatformAdmin(c, 'support');
    if (auth instanceof Response) return auth;

    const { data, error } = await auth.client.rpc('add_inquiry_note', {
      p_inquiry_id: c.req.valid('param').id,
      p_body: c.req.valid('json').body,
    });
    if (error) return sendPgError(c, error);

    return c.json({ id: data }, 201);
  },
);

function mapInquiry(i: Record<string, unknown>) {
  return {
    id: i.id,
    source: i.source,
    intent: i.intent,
    name: i.name,
    email: i.email,
    company: i.company,
    phone: i.phone,
    message: i.message,
    status: i.status,
    priority: i.priority,
    assignedTo: i.assigned_to,
    organizationId: i.organization_id,
    utmSource: i.utm_source,
    utmMedium: i.utm_medium,
    utmCampaign: i.utm_campaign,
    referrerHost: i.referrer_host,
    country: i.country,
    firstResponseAt: i.first_response_at,
    closedAt: i.closed_at,
    createdAt: i.created_at,
  };
}

export default app;
