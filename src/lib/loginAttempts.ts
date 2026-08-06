// Server-side login lockout — the real, unbypassable version of
// frontend/src/lib/loginAttempts.ts's exact policy (5 failed attempts locks
// an email out for 15 minutes). H6 fix (2026-08-04 security assessment,
// closed 2026-08-06): the client-side original can't stop anything that
// isn't the app's own sign-in form (clearing localStorage, or calling the
// API directly). This can — the state lives in Cloudflare KV, not the
// browser.
//
// Backed by KV rather than the Rate Limiting binding because KV has no cap
// on how long a value can be kept (the Rate Limiting binding's period is
// capped at 60s — see wrangler.toml's LOGIN_RATE_LIMITER comment for the
// fast, complementary volumetric guard that binding provides instead).
//
// KV is eventually consistent (Cloudflare's own model: writes can take up
// to ~60s to propagate across edge locations, last-write-wins on
// conflicting writes) — this is an accepted tradeoff for deterring/slowing
// brute force, not a claim that exactly 5 attempts and no more will ever
// get through under adversarial conditions. A Durable Object per key would
// give strong consistency at real added complexity; not justified here.

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
// Generous relative to the 15-minute lockout window purely so stale,
// long-since-irrelevant records don't accumulate in the namespace forever.
const KV_TTL_SECONDS = 60 * 60 * 24;

interface AttemptRecord {
  count: number;
  lockedUntil: number | null;
}

function storageKey(email: string): string {
  return `attempts:${email.trim().toLowerCase()}`;
}

async function readRecord(kv: KVNamespace, email: string): Promise<AttemptRecord> {
  const raw = await kv.get(storageKey(email));
  if (!raw) return { count: 0, lockedUntil: null };
  try {
    return JSON.parse(raw) as AttemptRecord;
  } catch {
    return { count: 0, lockedUntil: null };
  }
}

function writeRecord(kv: KVNamespace, email: string, record: AttemptRecord): Promise<void> {
  return kv.put(storageKey(email), JSON.stringify(record), { expirationTtl: KV_TTL_SECONDS });
}

export async function getLockoutStatus(
  kv: KVNamespace,
  email: string
): Promise<{ locked: boolean; remainingMs: number }> {
  if (!email) return { locked: false, remainingMs: 0 };
  const record = await readRecord(kv, email);
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return { locked: true, remainingMs: record.lockedUntil - Date.now() };
  }
  return { locked: false, remainingMs: 0 };
}

// Returns the resulting lockout status so the caller can surface it
// immediately without a second read.
export async function recordFailedAttempt(
  kv: KVNamespace,
  email: string
): Promise<{ locked: boolean; remainingMs: number }> {
  if (!email) return { locked: false, remainingMs: 0 };
  const record = await readRecord(kv, email);
  const count = record.count + 1;
  if (count >= MAX_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCKOUT_MS;
    await writeRecord(kv, email, { count: 0, lockedUntil });
    return { locked: true, remainingMs: LOCKOUT_MS };
  }
  await writeRecord(kv, email, { count, lockedUntil: null });
  return { locked: false, remainingMs: 0 };
}

export function clearAttempts(kv: KVNamespace, email: string): Promise<void> {
  if (!email) return Promise.resolve();
  return kv.delete(storageKey(email));
}

export function formatLockoutRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60000);
  return minutes <= 1 ? '1 minute' : `${minutes} minutes`;
}
