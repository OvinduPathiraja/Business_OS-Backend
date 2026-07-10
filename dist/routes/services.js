import { z } from 'zod';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';
const serviceBody = z.object({
    name: z.string().trim().min(1),
    description: z.string().optional().nullable(),
    price: z.number().min(0).optional(),
    durationOptions: z.array(z.number().positive()).optional(),
    allowsTime: z.boolean().optional(),
    allowsSlot: z.boolean().optional(),
    tint: z.string().optional(),
    icon: z.string().optional(),
});
const SELECT = 'id, organization_id, name, description, price, duration_options, allows_time, allows_slot, tint, icon';
function fromRow(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        description: row.description,
        price: Number(row.price),
        durationOptions: (row.duration_options ?? []).map(Number),
        allowsTime: row.allows_time,
        allowsSlot: row.allows_slot,
        tint: row.tint,
        icon: row.icon,
    };
}
export default async function servicesRoutes(app) {
    const server = app.withTypeProvider();
    server.get('/api/services', { schema: { querystring: paginationQuery } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        let query = auth.client.from('services').select(SELECT).order('name', { ascending: true });
        const { search, limit, offset } = request.query;
        if (search)
            query = query.ilike('name', `%${search}%`);
        query = query.range(offset, offset + limit - 1);
        const { data, error } = await query;
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map(fromRow));
    });
    server.post('/api/services', { schema: { body: serviceBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const b = request.body;
        const { data, error } = await auth.client
            .from('services')
            .insert({
            organization_id: auth.organizationId,
            name: b.name,
            description: b.description || null,
            price: b.price ?? 0,
            duration_options: b.durationOptions ?? [],
            allows_time: b.allowsTime ?? true,
            allows_slot: b.allowsSlot ?? true,
            ...(b.tint ? { tint: b.tint } : {}),
            ...(b.icon ? { icon: b.icon } : {}),
        })
            .select(SELECT)
            .single();
        if (error)
            return sendPgError(reply, error);
        reply.code(201).send(fromRow(data));
    });
    server.patch('/api/services/:id', { schema: { params: uuidParam, body: serviceBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const b = request.body;
        const { data, error } = await auth.client
            .from('services')
            .update({
            name: b.name,
            description: b.description || null,
            price: b.price ?? 0,
            duration_options: b.durationOptions ?? [],
            allows_time: b.allowsTime ?? true,
            allows_slot: b.allowsSlot ?? true,
            ...(b.tint ? { tint: b.tint } : {}),
            ...(b.icon ? { icon: b.icon } : {}),
        })
            .eq('id', request.params.id)
            .select(SELECT)
            .single();
        if (error)
            return sendPgError(reply, error);
        reply.send(fromRow(data));
    });
    server.delete('/api/services', { schema: { body: bulkIdsBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.from('services').delete().in('id', request.body.ids);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
}
