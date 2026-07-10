import { createClient } from '@supabase/supabase-js';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
}
// Runs every query *as* the calling user (their JWT is forwarded as the
// bearer token), so Postgres RLS — not hand-rolled auth logic here — decides
// what they can see or do. This is the client every route should use unless
// a specific operation genuinely requires bypassing RLS.
export function createUserClient(accessToken) {
    return createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
        auth: { autoRefreshToken: false, persistSession: false },
    });
}
// Bypasses RLS entirely via the service-role key. Not called by any route
// yet (foundation only) — reserved for privileged operations added later
// (e.g. the Supabase Admin API for real employee invites).
export function createServiceClient() {
    if (!supabaseServiceRoleKey) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set to use the service client.');
    }
    return createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}
export function bearerTokenFrom(authHeader) {
    if (!authHeader?.startsWith('Bearer '))
        return null;
    const token = authHeader.slice('Bearer '.length).trim();
    return token || null;
}
