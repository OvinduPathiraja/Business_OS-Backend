import type { Context } from 'hono';
import type { Bindings } from './supabase.js';
import type { OrgAuthResult } from './auth.js';

type HonoContext = Context<{ Bindings: Bindings }>;

export interface IdempotentResult {
  status: number;
  body: unknown;
}

// H-NEW-1 fix (2026-08-06 security assessment): wraps a money/stock-moving
// route handler so a client-supplied `Idempotency-Key` header makes a
// retried request replay the original response instead of re-executing the
// operation. Opt-in — a request with no header behaves exactly as before,
// so this is a pure addition, not a behavior change for existing clients
// until the frontend starts sending the header.
//
// Concurrency safety comes entirely from idempotency_keys' own
// (organization_id, route, key) UNIQUE constraint (see
// supabase/migrations/20260808030000_idempotency_keys.sql) — the INSERT
// below is the actual claim, and two requests racing on the same key can't
// both win it, the same "let the database resolve the race" pattern the
// money-moving RPCs themselves already use via row locks, just one layer up
// at the HTTP request instead of inside the transaction.
//
// A failed attempt (`result.status >= 400`) releases its claim, since it
// didn't create anything worth deduping against — otherwise a real
// validation error on the first attempt would permanently block every
// legitimate retry with that key.
export async function withIdempotency(
  c: HonoContext,
  auth: OrgAuthResult,
  route: string,
  run: () => Promise<IdempotentResult>
): Promise<Response> {
  const key = c.req.header('idempotency-key');
  if (!key) {
    const result = await run();
    return c.json(result.body as never, result.status as never);
  }

  const { data: claim, error: claimError } = await auth.client
    .from('idempotency_keys')
    .insert({ organization_id: auth.organizationId, route, key, created_by: auth.userId })
    .select('id')
    .single();

  if (claimError) {
    if (claimError.code === '23505') {
      const { data: existing } = await auth.client
        .from('idempotency_keys')
        .select('status, response_status, response_body')
        .eq('organization_id', auth.organizationId)
        .eq('route', route)
        .eq('key', key)
        .maybeSingle();
      if (existing?.status === 'completed') {
        return c.json(existing.response_body as never, (existing.response_status ?? 200) as never);
      }
      return c.json(
        {
          error: 'A request with this Idempotency-Key is already being processed.',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        },
        409
      );
    }
    // Any other claim failure (RLS misconfiguration, connectivity) fails
    // open to the underlying operation — an idempotency-layer problem
    // should not be able to block a legitimate, otherwise-authorized write.
    const result = await run();
    return c.json(result.body as never, result.status as never);
  }

  let result: IdempotentResult;
  try {
    result = await run();
  } catch (err) {
    await auth.client.from('idempotency_keys').delete().eq('id', claim.id);
    throw err;
  }

  if (result.status >= 400) {
    await auth.client.from('idempotency_keys').delete().eq('id', claim.id);
  } else {
    await auth.client
      .from('idempotency_keys')
      .update({
        status: 'completed',
        response_status: result.status,
        response_body: result.body,
        completed_at: new Date().toISOString(),
      })
      .eq('id', claim.id);
  }

  return c.json(result.body as never, result.status as never);
}
