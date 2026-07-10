import { z } from 'zod';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { uuidParam } from '../lib/schemas.js';
const listQuery = z.object({ limit: z.coerce.number().int().positive().max(100).optional().default(30) });
const SELECT = 'id, organization_id, type, title, body, read, created_at';
function fromRow(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        type: row.type,
        title: row.title,
        body: row.body,
        read: row.read,
        createdAt: row.created_at,
    };
}
// Only list/mark-read move here — subscribeToNotifications() stays on the
// direct Supabase Realtime client (see ROADMAP: rebuilding live push
// through Fastify needs a WebSocket/SSE layer, out of scope for this pass).
export default async function notificationsRoutes(app) {
    const server = app.withTypeProvider();
    server.get('/api/notifications', { schema: { querystring: listQuery } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('notifications')
            .select(SELECT)
            .order('created_at', { ascending: false })
            .limit(request.query.limit);
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map(fromRow));
    });
    server.patch('/api/notifications/:id/read', { schema: { params: uuidParam } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.from('notifications').update({ read: true }).eq('id', request.params.id);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
    server.patch('/api/notifications/read-all', async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client
            .from('notifications')
            .update({ read: true })
            .eq('organization_id', auth.organizationId)
            .eq('read', false);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
}
