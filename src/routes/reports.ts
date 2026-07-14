import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { validate } from '../lib/validate.js';
import { MAX_RANGE_DAYS, computePeriodStats, dateKey, parseDateKey, rangeDays, resolveRange } from '../lib/periodStats.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const reportsQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
}).refine((q) => (q.from == null) === (q.to == null), { message: 'from and to must be provided together' })
  .refine((q) => !q.from || !q.to || parseDateKey(q.from) <= parseDateKey(q.to), { message: 'from must not be after to' })
  .refine((q) => !q.from || !q.to || rangeDays({ from: parseDateKey(q.from), to: parseDateKey(q.to) }) <= MAX_RANGE_DAYS, {
    message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
  });

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/reports', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const range = resolveRange(from, to, 30);
  const stats = await computePeriodStats(c, auth, range);
  if (stats instanceof Response) return stats;

  return c.json({ from: dateKey(range.from), to: dateKey(range.to), ...stats });
});

export default app;
