import { Hono } from 'hono';
import type { Bindings } from '../lib/supabase.js';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';

// What THIS tenant owes US — deliberately not under /api/admin/, and just as
// deliberately not part of the Finance module. Finance is the tenant billing
// their own customers; this is our bill to them, and the platform_ prefix on
// the underlying tables exists precisely so the two can never be joined by
// accident (see 20260730010000_platform_billing.sql's header).
//
// Read-only, with no write routes at all: payment is collected out of band and
// recorded by an operator, so there is nothing here for a tenant to submit.
// The screen's whole job is "here is what to pay, and by when".
//
// Both RPCs resolve the organization through current_organization_id() rather
// than taking it as a parameter, which is what makes them safe to expose to a
// tenant despite reading tables tenants have no RLS access to.
const app = new Hono<{ Bindings: Bindings }>();

// requireUser, not requireOrg: a member of a suspended org still gets a
// coherent answer here (null) rather than a 403 they can't interpret.
app.get('/api/billing', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.rpc('my_subscription_state');
  if (error) return sendPgError(c, error);

  // Null means no subscription row — full access, nothing to show. The client
  // renders an empty state rather than an error.
  return c.json({ subscription: data ?? null });
});

app.get('/api/billing/invoices', async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.client.rpc('my_platform_invoices');
  if (error) return sendPgError(c, error);

  return c.json({
    invoices: (data ?? []).map((row: any) => ({
      number: row.number,
      status: row.status,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      total: Number(row.total ?? 0),
      amountPaid: Number(row.amount_paid ?? 0),
      balance: Number(row.balance ?? 0),
      currency: row.currency,
    })),
  });
});

export default app;
