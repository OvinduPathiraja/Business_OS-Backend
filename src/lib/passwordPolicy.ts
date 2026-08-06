// Canonical password strength rule for this backend — the server-side half
// of frontend/src/lib/passwordPolicy.ts (a separate repo/package, so this is
// a deliberate mirror, not an import; the two must be kept in sync by hand).
//
// Previously only backend/src/routes/employees.ts's username-invite route
// checked this server-side, because it was the one place a password reached
// the backend at all — every other password flow went straight from client
// to Supabase Auth. That's no longer true: routes/session.ts's
// /api/auth/signup and /api/auth/set-password (the M3 cookie-session
// migration, 2026-08-04 security assessment) now receive a raw password
// server-side too, and are what actually closes the H5 finding (client-only
// enforcement) — this file is what all three call sites share.
const RULES: { test: (v: string) => boolean; label: string }[] = [
  { test: (v) => v.length >= 8, label: 'at least 8 characters' },
  { test: (v) => /[A-Z]/.test(v), label: 'an uppercase letter' },
  { test: (v) => /[a-z]/.test(v), label: 'a lowercase letter' },
  { test: (v) => /[0-9]/.test(v), label: 'a number' },
  { test: (v) => /[^A-Za-z0-9]/.test(v), label: 'a special character' },
];

// Returns the unmet requirement labels, in order — empty array means the
// password is strong enough.
export function passwordIssues(password: string): string[] {
  return RULES.filter((r) => !r.test(password)).map((r) => r.label);
}
