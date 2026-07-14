import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { validate } from '../lib/validate.js';
import { PERIODS, computePeriodStats } from '../lib/periodStats.js';

const reportsQuery = z.object({
  period: z.coerce.number().refine((n): n is (typeof PERIODS)[number] => (PERIODS as readonly number[]).includes(n)).optional().default(30),
});

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/reports', validate('query', reportsQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const period = c.req.valid('query').period;
  const stats = await computePeriodStats(c, auth, period);
  if (stats instanceof Response) return stats;

  return c.json({ period, ...stats });
});

export default app;
