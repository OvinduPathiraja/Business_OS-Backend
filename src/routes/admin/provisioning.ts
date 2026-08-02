import { Hono } from 'hono';
import { z } from 'zod';
import { createServiceClient, type Bindings } from '../../lib/supabase.js';
import { requirePlatformAdmin } from '../../lib/platformAuth.js';
import { sendPgError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { uuidParam } from '../../lib/schemas.js';
import { sendInviteEmail } from '../../lib/email.js';

// Setting a paying customer up from the operator console: create their
// account, create their workspace, put them on a plan, and send them a link
// to set a password — in one request, because doing it as four separate
// operator actions is four chances to leave a half-built tenant behind.
//
// Also the period/trial/grace controls and device help-desk actions, which
// are here rather than in billing.ts because they exist for the same reason:
// this is the file for "an operator is doing something on a customer's
// behalf".
const app = new Hono<{ Bindings: Bindings }>();

const provisionBody = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().min(1).max(120),
  organizationName: z.string().trim().min(1).max(120),
  currency: z.string().trim().length(3).optional(),
  planCode: z.string().trim().min(1),
  billingInterval: z.enum(['monthly', 'annual']).default('monthly'),
  // 0 means "start paid today" — a customer who has already transferred the
  // money should not be handed a trial.
  trialDays: z.number().int().min(0).max(365).default(14),
  amountOverride: z.number().nonnegative().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});

app.post('/api/admin/provision', validate('json', provisionBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'billing');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const svc = createServiceClient(c.env);

  // Which of the two paths this is. inviteUserByEmail() fails outright for an
  // address that already has an account, so this has to be decided before
  // calling it — the same lookup and the same reasoning as
  // routes/employees.ts' invite route.
  const { data: existing, error: lookupError } = await svc
    .from('profiles')
    .select('id')
    .eq('email', b.email)
    .maybeSingle();
  if (lookupError) return sendPgError(c, lookupError);

  let userId: string;
  // Tracked so the compensating delete below can never fire for an account
  // we merely FOUND. Deleting a real customer's login because an org insert
  // failed would be considerably worse than the problem it's cleaning up.
  let createdUser = false;

  if (existing) {
    userId = existing.id as string;
  } else {
    const { data: invited, error: inviteError } = await svc.auth.admin.inviteUserByEmail(b.email, {
      data: { full_name: b.fullName },
      redirectTo: c.env.PUBLIC_APP_URL,
    });
    if (inviteError || !invited?.user) {
      const rateLimited = /rate limit/i.test(inviteError?.message ?? '');
      return c.json(
        {
          error: rateLimited
            ? 'Too many invite emails sent recently — wait a few minutes and try again.'
            : inviteError?.message ?? 'Could not send the invite.',
          code: 'INVITE_FAILED',
        },
        rateLimited ? 429 : 500
      );
    }
    userId = invited.user.id;
    createdUser = true;
  }

  // No transaction spans these three calls (they are separate PostgREST
  // round trips), so each failure below undoes what this request created and
  // nothing else.
  const { data: orgId, error: orgError } = await auth.client.rpc('admin_create_organization', {
    p_owner_user_id: userId,
    p_name: b.organizationName,
    p_currency: b.currency ?? 'USD',
  });
  if (orgError || !orgId) {
    if (createdUser) await svc.auth.admin.deleteUser(userId);
    return sendPgError(c, orgError ?? { message: 'Could not create the organization.' });
  }

  // The insert above already gave them a starter/trialing subscription via
  // the trigger; this moves them onto the plan actually agreed.
  const trialEndsAt =
    b.trialDays > 0
      ? new Date(Date.now() + b.trialDays * 86400000).toISOString().slice(0, 10)
      : null;

  const { error: planError } = await auth.client.rpc('set_organization_plan', {
    p_organization_id: orgId,
    p_plan_code: b.planCode,
    p_billing_interval: b.billingInterval,
    p_status: b.trialDays > 0 ? 'trialing' : 'active',
    p_amount_override: b.amountOverride ?? null,
    p_trial_ends_at: trialEndsAt,
    p_notes: b.notes ?? null,
  });
  if (planError) {
    // The workspace exists and is usable at this point, so it is deliberately
    // NOT deleted — deleting it would cascade the membership and roles that
    // were seeded correctly. The operator can set the plan from the
    // subscription editor; the org is already in the list.
    return c.json(
      {
        error: `The workspace was created but the plan could not be set: ${planError.message}`,
        code: 'PLAN_FAILED',
        organizationId: orgId,
        userId,
      },
      500
    );
  }

  // An existing account gets no Supabase invite (they already have a
  // password), so this is the only thing telling them a new workspace is
  // waiting. Best-effort: the membership is real either way and shows up the
  // next time they open the app.
  let emailSent = true;
  if (!createdUser) {
    try {
      await sendInviteEmail(c.env, {
        to: b.email,
        orgName: b.organizationName,
        appUrl: c.env.PUBLIC_APP_URL,
      });
    } catch {
      emailSent = false;
    }
  }

  return c.json(
    { userId, organizationId: orgId, existingAccount: !createdUser, emailSent },
    201
  );
});

const periodBody = z.object({
  currentPeriodStart: z.string().date().optional(),
  currentPeriodEnd: z.string().date().optional(),
  trialEndsAt: z.string().date().optional(),
  graceDays: z.number().int().min(0).max(365).optional(),
});

app.post('/api/admin/organizations/:id/period', validate('param', uuidParam), validate('json', periodBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'billing');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const { error } = await auth.client.rpc('admin_set_subscription_period', {
    p_organization_id: c.req.valid('param').id,
    p_current_period_start: b.currentPeriodStart ?? null,
    p_current_period_end: b.currentPeriodEnd ?? null,
    p_trial_ends_at: b.trialEndsAt ?? null,
    p_grace_days: b.graceDays ?? null,
  });
  if (error) return sendPgError(c, error);

  return c.body(null, 204);
});

const billBody = z.object({
  periodStart: z.string().date().optional(),
  periodEnd: z.string().date().optional(),
  advancePeriod: z.boolean().default(true),
  // The common case for this business: the transfer already landed, and the
  // invoice is a record of it rather than a request for it.
  markPaid: z.boolean().default(false),
  method: z.enum(['bank_transfer', 'card', 'cash', 'cheque', 'other']).default('bank_transfer'),
  reference: z.string().trim().max(120).optional(),
});

// Issue an invoice and, optionally, record it as paid — collapsing what was
// two separate operator actions. Kept as one route rather than a client-side
// sequence so a browser closed between the two steps cannot leave an invoice
// that was paid in reality but open in the system.
app.post('/api/admin/organizations/:id/bill', validate('param', uuidParam), validate('json', billBody), async (c) => {
  const auth = await requirePlatformAdmin(c, 'billing');
  if (auth instanceof Response) return auth;

  const b = c.req.valid('json');
  const organizationId = c.req.valid('param').id;

  const { data: invoiceId, error } = await auth.client.rpc('create_platform_invoice', {
    p_organization_id: organizationId,
    p_period_start: b.periodStart ?? null,
    p_period_end: b.periodEnd ?? null,
    p_advance_period: b.advancePeriod,
  });
  if (error || !invoiceId) return sendPgError(c, error ?? { message: 'Could not create the invoice.' });

  if (!b.markPaid) return c.json({ invoiceId, paid: false }, 201);

  // Read the total back rather than recomputing it here — create_platform_invoice()
  // derives the amount from the same MRR definition the revenue chart uses,
  // and a second calculation in TypeScript is a second chance to disagree.
  const { data: invoice, error: readError } = await auth.client
    .from('platform_invoices')
    .select('total')
    .eq('id', invoiceId)
    .single();
  if (readError) return sendPgError(c, readError);

  const { error: paymentError } = await auth.client.rpc('record_platform_payment', {
    p_invoice_id: invoiceId,
    p_amount: Number(invoice.total ?? 0),
    p_method: b.method,
    p_reference: b.reference ?? null,
  });
  if (paymentError) {
    // The invoice stands — it is a real bill. Say what happened rather than
    // hiding a half-completed action behind a generic 500.
    return c.json(
      {
        error: `Invoice ${invoiceId} was created but the payment could not be recorded: ${paymentError.message}`,
        code: 'PAYMENT_FAILED',
        invoiceId,
      },
      500
    );
  }

  return c.json({ invoiceId, paid: true }, 201);
});

// ---------------------------------------------------------------------------
// Device help desk. 'support' rank — this is unsticking a customer, not money.
// ---------------------------------------------------------------------------
app.get('/api/admin/users/:id/devices', validate('param', uuidParam), async (c) => {
  const auth = await requirePlatformAdmin(c, 'support');
  if (auth instanceof Response) return auth;

  // auth.client, not svc: user_devices' select policy already admits
  // is_platform_admin(), so the operator's own JWT is sufficient and the
  // service key stays out of a routine read.
  const { data, error } = await auth.client
    .from('user_devices')
    .select('device_id, label, platform, app, first_seen_at, last_seen_at, revoked_at')
    .eq('user_id', c.req.valid('param').id)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false });
  if (error) return sendPgError(c, error);

  return c.json({
    devices: (data ?? []).map((d: Record<string, unknown>) => ({
      deviceId: d.device_id,
      label: d.label,
      platform: d.platform,
      app: d.app,
      firstSeenAt: d.first_seen_at,
      lastSeenAt: d.last_seen_at,
    })),
  });
});

const revokeParam = z.object({
  id: z.string().uuid(),
  deviceId: z.string().trim().min(1).max(128),
});

app.post('/api/admin/users/:id/devices/:deviceId/revoke', validate('param', revokeParam), async (c) => {
  const auth = await requirePlatformAdmin(c, 'support');
  if (auth instanceof Response) return auth;

  const p = c.req.valid('param');
  const { error } = await auth.client.rpc('admin_revoke_device', {
    p_user_id: p.id,
    p_device_id: p.deviceId,
  });
  if (error) return sendPgError(c, error);

  return c.body(null, 204);
});

export default app;
