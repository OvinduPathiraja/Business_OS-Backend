import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings } from './lib/supabase.js';
import { bearerTokenFrom } from './lib/supabase.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/session.js';
import meRoutes from './routes/me.js';
import organizationsRoutes from './routes/organizations.js';
import customersRoutes from './routes/customers.js';
import servicesRoutes from './routes/services.js';
import inventoryRoutes from './routes/inventory.js';
import branchesRoutes from './routes/branches.js';
import ordersRoutes from './routes/orders.js';
import bookingsRoutes from './routes/bookings.js';
import quotationsRoutes from './routes/quotations.js';
import purchaseOrdersRoutes from './routes/purchaseOrders.js';
import suppliersRoutes from './routes/suppliers.js';
import promotionsRoutes from './routes/promotions.js';
import chargesRoutes from './routes/charges.js';
import financeRoutes from './routes/finance.js';
import vendorsRoutes from './routes/vendors.js';
import payablesRoutes from './routes/payables.js';
import bankRoutes from './routes/bank.js';
import ledgersRoutes from './routes/ledgers.js';
import taxesRoutes from './routes/taxes.js';
import rolesRoutes from './routes/roles.js';
import employeesRoutes from './routes/employees.js';
import notificationsRoutes from './routes/notifications.js';
import reportsRoutes from './routes/reports.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';
import printersRoutes from './routes/printers.js';
import departmentsRoutes from './routes/departments.js';
import tasksRoutes from './routes/tasks.js';
import completionsRoutes from './routes/completions.js';
import queueRoutes from './routes/queue.js';
import scanSessionsRoutes from './routes/scanSessions.js';
import viewsRoutes from './routes/views.js';
import impersonationRoutes from './routes/impersonation.js';
import uploadsRoutes from './routes/uploads.js';
import devicesRoutes from './routes/devices.js';
import billingRoutes from './routes/billing.js';
import adminRoutes from './routes/admin/index.js';
import publicRoutes from './routes/public.js';
import { requestLogger } from './lib/requestLog.js';

export function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  // ALLOWED_ORIGIN only exists on c.env at request time (Workers has no
  // process.env), so this wraps hono/cors in a per-request middleware
  // instead of configuring it once at module load.
  app.use('*', async (c, next) => {
    const allowedOrigin = c.env.ALLOWED_ORIGIN;
    // Found during the 2026-08-04 security assessment: an unset
    // ALLOWED_ORIGIN silently fell back to '*' (open to any origin). Not
    // exploitable today — this API is Bearer-token, not cookie/credential
    // based, so a wildcard alone can't forge another user's Authorization
    // header — but it's a footgun for a future redeploy that drops the
    // secret. Default to an empty allowlist instead: hono/cors only ever
    // echoes back an origin present in the list, so an empty one means no
    // browser cross-origin request ever gets a matching
    // Access-Control-Allow-Origin, while same-origin and non-browser
    // callers (curl, the mobile app) are completely unaffected — CORS is
    // a browser-enforced check only. Logged loudly rather than failing the
    // whole API closed, since an outage is a worse failure mode than a
    // temporarily-locked-down CORS policy for a misconfigured secret.
    if (!allowedOrigin) {
      console.error('ALLOWED_ORIGIN is not set — defaulting to no cross-origin browser access allowed.');
    }
    const middleware = cors({
      origin: allowedOrigin ? allowedOrigin.split(',').map((o) => o.trim()) : [],
      // Custom response headers are invisible to browser JS unless listed
      // here — X-Total-Count backs paginated tables (Customers, Services).
      exposeHeaders: ['X-Total-Count'],
      // Required for the httpOnly session cookies (M3 fix, 2026-08-04
      // security assessment, routes/session.ts) to be sent/received
      // cross-origin via fetch(credentials: 'include'). Safe alongside the
      // allowlist above: hono/cors only ever echoes a listed origin, never
      // '*', and credentials:true requires exactly that — it refuses to
      // pair with a wildcard origin by spec, which this config already
      // guarantees never happens.
      credentials: true,
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

  // Traffic logging for the operator console's Traffic screen. Mounted AFTER
  // the rate limiter on purpose — a request rejected with 429 should still be
  // counted, since a spike in those is exactly the kind of thing the screen
  // exists to make visible. It records only after the response is ready and
  // never blocks it (see lib/requestLog.ts).
  app.use('*', requestLogger());

  // Safety net for anything unexpected — Postgres/PostgREST errors returned
  // as `{ error }` from a supabase-js call are handled at the call site via
  // sendPgError(), not here. Zod validation failures are handled by
  // validate()'s own hook, also not here.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  app.route('/', healthRoutes);
  app.route('/', authRoutes);
  app.route('/', sessionRoutes);
  app.route('/', meRoutes);
  app.route('/', organizationsRoutes);
  app.route('/', customersRoutes);
  app.route('/', servicesRoutes);
  app.route('/', inventoryRoutes);
  app.route('/', branchesRoutes);
  app.route('/', ordersRoutes);
  app.route('/', bookingsRoutes);
  app.route('/', quotationsRoutes);
  app.route('/', purchaseOrdersRoutes);
  app.route('/', suppliersRoutes);
  app.route('/', promotionsRoutes);
  app.route('/', chargesRoutes);
  app.route('/', financeRoutes);
  app.route('/', vendorsRoutes);
  app.route('/', payablesRoutes);
  app.route('/', bankRoutes);
  app.route('/', ledgersRoutes);
  app.route('/', taxesRoutes);
  app.route('/', rolesRoutes);
  app.route('/', employeesRoutes);
  app.route('/', notificationsRoutes);
  app.route('/', reportsRoutes);
  app.route('/', activityRoutes);
  app.route('/', dashboardRoutes);
  app.route('/', printersRoutes);
  app.route('/', departmentsRoutes);
  app.route('/', tasksRoutes);
  app.route('/', completionsRoutes);
  app.route('/', queueRoutes);
  app.route('/', scanSessionsRoutes);
  app.route('/', viewsRoutes);
  app.route('/', impersonationRoutes);
  app.route('/', uploadsRoutes);
  app.route('/', devicesRoutes);
  app.route('/', billingRoutes);

  // Unauthenticated: the marketing site's contact form and page beacon. Kept
  // last and in their own file so the boundary between "needs a bearer token"
  // and "open to the internet" stays obvious (see routes/public.ts).
  app.route('/', publicRoutes);

  // The platform operator console — cross-tenant, gated by
  // requirePlatformAdmin() rather than by RLS (see lib/platformAuth.ts).
  app.route('/', adminRoutes);

  return app;
}
