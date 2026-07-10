import { z } from 'zod';
import { requireOrg } from '../lib/auth.js';
import { sendPgError } from '../lib/errors.js';
import { paginationQuery, uuidParam, bulkIdsBody } from '../lib/schemas.js';
const LIFECYCLE_STAGES = ['lead', 'active', 'vip', 'dormant', 'archived'];
const listQuery = paginationQuery.extend({
    lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
});
const customerBody = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().email().optional().nullable(),
    phone: z.string().trim().optional().nullable(),
    lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
    notes: z.string().optional().nullable(),
});
const SELECT = 'id, organization_id, name, email, phone, lifecycle_stage, notes, created_at';
function fromRow(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        lifecycleStage: row.lifecycle_stage,
        notes: row.notes,
        createdAt: row.created_at,
    };
}
export default async function customersRoutes(app) {
    const server = app.withTypeProvider();
    server.get('/api/customers', { schema: { querystring: listQuery } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        let query = auth.client.from('customers').select(SELECT).order('created_at', { ascending: false });
        const { search, lifecycleStage, limit, offset } = request.query;
        if (search)
            query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
        if (lifecycleStage)
            query = query.eq('lifecycle_stage', lifecycleStage);
        query = query.range(offset, offset + limit - 1);
        const { data, error } = await query;
        if (error)
            return sendPgError(reply, error);
        reply.send((data ?? []).map(fromRow));
    });
    server.post('/api/customers', { schema: { body: customerBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('customers')
            .insert({
            organization_id: auth.organizationId,
            name: request.body.name,
            email: request.body.email || null,
            phone: request.body.phone || null,
            lifecycle_stage: request.body.lifecycleStage ?? 'lead',
            notes: request.body.notes || null,
        })
            .select(SELECT)
            .single();
        if (error)
            return sendPgError(reply, error);
        reply.code(201).send(fromRow(data));
    });
    server.patch('/api/customers/:id', { schema: { params: uuidParam, body: customerBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { data, error } = await auth.client
            .from('customers')
            .update({
            name: request.body.name,
            email: request.body.email || null,
            phone: request.body.phone || null,
            lifecycle_stage: request.body.lifecycleStage,
            notes: request.body.notes || null,
            updated_at: new Date().toISOString(),
        })
            .eq('id', request.params.id)
            .select(SELECT)
            .single();
        if (error)
            return sendPgError(reply, error);
        reply.send(fromRow(data));
    });
    server.delete('/api/customers', { schema: { body: bulkIdsBody } }, async (request, reply) => {
        const auth = await requireOrg(request, reply);
        if (!auth)
            return;
        const { error } = await auth.client.from('customers').delete().in('id', request.body.ids);
        if (error)
            return sendPgError(reply, error);
        reply.code(204).send();
    });
}
