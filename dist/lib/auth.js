import { bearerTokenFrom, createUserClient } from './supabase.js';
// Verifies the caller's Supabase JWT and hands back a client scoped to them,
// so every subsequent query is authorized by existing RLS policies rather
// than by anything this server decides on its own. Sends the error response
// itself and returns null on failure, so callers can just `if (!auth) return;`.
export async function requireUser(request, reply) {
    const token = bearerTokenFrom(request.headers.authorization);
    if (!token) {
        reply.code(401).send({ ok: false, error: 'Missing bearer token.' });
        return null;
    }
    const client = createUserClient(token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
        reply.code(401).send({ ok: false, error: 'Invalid or expired session.' });
        return null;
    }
    return { client, userId: data.user.id };
}
// Wraps requireUser() with one extra lookup for the caller's organization_id
// — for routes that create org-scoped rows (customers, orders, etc.). Those
// used to trust a client-supplied organizationId parameter, validated only
// by RLS on write; this derives it server-side instead, the same way
// current_organization_id() already does inside Postgres.
export async function requireOrg(request, reply) {
    const auth = await requireUser(request, reply);
    if (!auth)
        return null;
    const { data, error } = await auth.client
        .from('profiles')
        .select('organization_id')
        .eq('id', auth.userId)
        .single();
    if (error || !data?.organization_id) {
        reply.code(403).send({ error: 'You are not part of an organization.' });
        return null;
    }
    return { ...auth, organizationId: data.organization_id };
}
