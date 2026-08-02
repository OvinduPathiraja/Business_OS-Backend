import { Hono } from 'hono';
import type { Bindings } from '../../lib/supabase.js';
import overviewRoutes from './overview.js';
import organizationsRoutes from './organizations.js';
import billingRoutes from './billing.js';
import usersRoutes from './users.js';
import trafficRoutes from './traffic.js';
import inquiriesRoutes from './inquiries.js';
import impersonateRoutes from './impersonate.js';
import auditRoutes from './audit.js';

// The operator console's API surface. Everything mounted here reads or writes
// ACROSS TENANTS and is gated by requirePlatformAdmin() — see
// backend/src/lib/platformAuth.ts for why that gate is structured the way it is.
//
// A note on where authorization actually lives: most handlers below call a
// SECURITY DEFINER RPC that re-checks is_platform_admin() in Postgres. That is
// deliberate belt-and-braces — the route gate and the database gate are
// independent, so a mistake in one does not silently open the other.
//
// IMPORTANT CONVENTION, easy to get wrong: RPCs must be called through
// `auth.client` (the caller's own JWT), never `auth.svc`. Every platform RPC
// resolves the caller via auth.uid(), which is NULL under the service-role key
// — using svc would make every one of them fail closed with "Not authorized".
// `auth.svc` is only for cross-tenant reads of TENANT tables (organizations,
// profiles) whose RLS would otherwise scope them to one org, and for writing
// the audit log.
export function buildAdminRoutes() {
  const app = new Hono<{ Bindings: Bindings }>();

  app.route('/', overviewRoutes);
  app.route('/', organizationsRoutes);
  app.route('/', billingRoutes);
  app.route('/', usersRoutes);
  app.route('/', trafficRoutes);
  app.route('/', inquiriesRoutes);
  app.route('/', impersonateRoutes);
  app.route('/', auditRoutes);

  return app;
}

export default buildAdminRoutes();
