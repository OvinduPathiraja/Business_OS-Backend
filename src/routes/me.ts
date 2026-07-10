import type { FastifyInstance } from 'fastify';
import { requireUser } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';

// Currency formatting/symbol lookup is a frontend display concern
// (src/lib/currency.ts) — the backend only needs the bare fallback code.
const DEFAULT_CURRENCY = 'USD';

// Replaces frontend/src/auth.tsx's fetchProfile() — collapses its two
// sequential queries (profile+role+org, then a separate role_permissions
// query) into one round trip, run on every app boot and auth-state change.
export default async function meRoutes(app: FastifyInstance) {
  app.get('/api/me', async (request, reply) => {
    const auth = await requireUser(request, reply);
    if (!auth) return;

    const { data, error } = await auth.client
      .from('profiles')
      .select('id, organization_id, full_name, role_id, roles(name, is_owner), organizations(name, currency)')
      .eq('id', auth.userId)
      .single();

    if (error) return sendPgError(reply, error);

    const roles = data.roles as unknown as { name: string; is_owner: boolean } | { name: string; is_owner: boolean }[] | null;
    const roleRow = Array.isArray(roles) ? roles[0] : roles;
    const orgs = data.organizations as unknown as { name: string; currency: string } | { name: string; currency: string }[] | null;
    const org = Array.isArray(orgs) ? orgs[0] : orgs;

    let permissions: string[] = [];
    if (data.role_id) {
      const { data: permRows, error: permErr } = await auth.client
        .from('role_permissions')
        .select('permissions(key)')
        .eq('role_id', data.role_id);
      if (permErr) return sendPgError(reply, permErr);
      permissions = (permRows ?? [])
        .map((r: any) => (Array.isArray(r.permissions) ? r.permissions[0]?.key : r.permissions?.key))
        .filter(Boolean);
    }

    reply.send({
      id: data.id,
      organizationId: data.organization_id,
      organizationName: org?.name ?? null,
      currency: org?.currency ?? DEFAULT_CURRENCY,
      fullName: data.full_name,
      roleName: roleRow?.name ?? null,
      roleIsOwner: roleRow?.is_owner ?? false,
      permissions,
    });
  });
}
