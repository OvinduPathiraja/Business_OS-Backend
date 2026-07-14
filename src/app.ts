import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings } from './lib/supabase.js';
import { bearerTokenFrom } from './lib/supabase.js';
import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
import organizationsRoutes from './routes/organizations.js';
import customersRoutes from './routes/customers.js';
import servicesRoutes from './routes/services.js';
import inventoryRoutes from './routes/inventory.js';
import ordersRoutes from './routes/orders.js';
import bookingsRoutes from './routes/bookings.js';
import financeRoutes from './routes/finance.js';
import rolesRoutes from './routes/roles.js';
import employeesRoutes from './routes/employees.js';
import notificationsRoutes from './routes/notifications.js';
import reportsRoutes from './routes/reports.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';

export function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  // ALLOWED_ORIGIN only exists on c.env at request time (Workers has no
  // process.env), so this wraps hono/cors in a per-request middleware
  // instead of configuring it once at module load.
  app.use('*', async (c, next) => {
    const allowedOrigin = c.env.ALLOWED_ORIGIN;
    const middleware = cors({
      origin: allowedOrigin ? allowedOrigin.split(',').map((o) => o.trim()) : '*',
      // Custom response headers are invisible to browser JS unless listed
      // here — X-Total-Count backs paginated tables (Customers, Services).
      exposeHeaders: ['X-Total-Count'],
    });
    return middleware(c, next);
  });

  // Cloudflare's native Rate Limiting binding — edge-distributed by
  // default, correct across the whole Workers fleet with no shared store
  // needed (unlike the in-memory limiter this replaces, which only worked
  // correctly for a single Railway instance).
  app.use('*', async (c, next) => {
    const key = bearerTokenFrom(c.req.header('authorization')) ?? c.req.header('cf-connecting-ip') ?? 'anonymous';
    const { success } = await c.env.RATE_LIMITER.limit({ key });
    if (!success) {
      return c.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429);
    }
    await next();
  });

  // Safety net for anything unexpected — Postgres/PostgREST errors returned
  // as `{ error }` from a supabase-js call are handled at the call site via
  // sendPgError(), not here. Zod validation failures are handled by
  // validate()'s own hook, also not here.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  app.route('/', healthRoutes);
  app.route('/', meRoutes);
  app.route('/', organizationsRoutes);
  app.route('/', customersRoutes);
  app.route('/', servicesRoutes);
  app.route('/', inventoryRoutes);
  app.route('/', ordersRoutes);
  app.route('/', bookingsRoutes);
  app.route('/', financeRoutes);
  app.route('/', rolesRoutes);
  app.route('/', employeesRoutes);
  app.route('/', notificationsRoutes);
  app.route('/', reportsRoutes);
  app.route('/', activityRoutes);
  app.route('/', dashboardRoutes);

  return app;
}
