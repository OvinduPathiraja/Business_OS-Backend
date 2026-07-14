import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { MAX_RANGE_DAYS, computePeriodStats, dateKey, parseDateKey, rangeDays, resolveRange, startOfToday } from '../lib/periodStats.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dashboardQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
}).refine((q) => (q.from == null) === (q.to == null), { message: 'from and to must be provided together' })
  .refine((q) => !q.from || !q.to || parseDateKey(q.from) <= parseDateKey(q.to), { message: 'from must not be after to' })
  .refine((q) => !q.from || !q.to || rangeDays({ from: parseDateKey(q.from), to: parseDateKey(q.to) }) <= MAX_RANGE_DAYS, {
    message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
  });

const app = new Hono<{ Bindings: Bindings }>();

// The one thing computePeriodStats() (shared with reports.ts) doesn't cover:
// a true "right now" snapshot — how many orders/bookings exist for *today*,
// and what's still ahead on today's schedule. Everything else in the
// response is the same range-scoped aggregation Reports.tsx already shows.
app.get('/api/dashboard', validate('query', dashboardQuery), async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { from, to } = c.req.valid('query');
  const range = resolveRange(from, to, 7);
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayKey = dateKey(today);
  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60;

  const [stats, ordersTodayRes, bookingsTodayRes] = await Promise.all([
    computePeriodStats(c, auth, range),
    auth.client.from('orders').select('id, created_at').gte('created_at', today.toISOString()).lt('created_at', tomorrow.toISOString()),
    auth.client
      .from('bookings')
      .select('id, customer_name, service_name, start_hour, end_hour')
      .eq('booking_date', todayKey)
      .eq('status', 'confirmed')
      .order('start_hour', { ascending: true }),
  ]);

  if (stats instanceof Response) return stats;
  if (ordersTodayRes.error) return sendPgError(c, ordersTodayRes.error);
  if (bookingsTodayRes.error) return sendPgError(c, bookingsTodayRes.error);

  const bookingsToday = bookingsTodayRes.data ?? [];
  const upcomingBookings = bookingsToday
    .filter((b: any) => Number(b.start_hour) >= nowHour)
    .slice(0, 5)
    .map((b: any) => ({
      id: b.id,
      customerName: b.customer_name,
      serviceName: b.service_name,
      startHour: Number(b.start_hour),
      endHour: Number(b.end_hour),
    }));

  return c.json({
    from: dateKey(range.from),
    to: dateKey(range.to),
    today: {
      ordersToday: (ordersTodayRes.data ?? []).length,
      bookingsToday: bookingsToday.length,
      upcomingBookings,
    },
    ...stats,
  });
});

export default app;
