import { dateKey, parseDateKey, rangeDays, type DateRange } from './periodStats.js';

// Bucket granularity for the Finance report's trend charts. Chosen from the
// range length so a chart never has to render more than a few dozen columns
// — a decade selected at daily resolution would be ~3650 unreadable bars.
export type Granularity = 'day' | 'week' | 'month' | 'year';

export function chooseGranularity(days: number): Granularity {
  if (days <= 62) return 'day';
  if (days <= 400) return 'week';
  if (days <= 1827) return 'month'; // ~5 years
  return 'year';
}

// Monday-anchored, mirroring DateRangePicker's own startOfWeek().
function startOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const r = new Date(d);
  r.setDate(r.getDate() + diff);
  return r;
}

function bucketKeyFor(d: Date, g: Granularity): string {
  switch (g) {
    case 'day': return dateKey(d);
    case 'week': return dateKey(startOfWeek(d));
    case 'month': return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    case 'year': return String(d.getFullYear());
  }
}

export interface FinanceSeriesPoint {
  key: string;
  moneyIn: number;
  moneyOut: number;
}

// Ordered, zero-filled bucket keys spanning the whole range — same "fill the
// gaps" approach as computePeriodStats' dailyRevenue, just at a coarser
// grain. The day-by-day walk is cheap (a plain loop, no I/O) even across a
// decade; it only ever runs once per request.
function bucketKeysFor(range: DateRange, g: Granularity): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const cur = new Date(range.from);
  while (cur <= range.to) {
    const k = bucketKeyFor(cur, g);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

// Aggregates paid invoices (money in) and paid bills (money out) — the same
// two datasets /api/reports/finance already fetches for `revenue` and
// `totalExpenses` — into one bucketed series for the Inflows/Outflows and
// Growth charts. Money in/out here matches those headline totals exactly
// (custom ledger movement is a separate breakdown and isn't folded in, to
// avoid double-counting against the KPIs the chart sits under).
export function buildFinanceSeries(
  range: DateRange,
  invoices: { total: number; created_at: string }[],
  bills: { total: number; created_at: string }[]
): { granularity: Granularity; series: FinanceSeriesPoint[] } {
  const g = chooseGranularity(rangeDays(range));
  const inByBucket = new Map<string, number>();
  invoices.forEach((i) => {
    const k = bucketKeyFor(parseDateKey(String(i.created_at).slice(0, 10)), g);
    inByBucket.set(k, (inByBucket.get(k) ?? 0) + Number(i.total));
  });
  const outByBucket = new Map<string, number>();
  bills.forEach((b) => {
    const k = bucketKeyFor(parseDateKey(String(b.created_at).slice(0, 10)), g);
    outByBucket.set(k, (outByBucket.get(k) ?? 0) + Number(b.total));
  });

  const series = bucketKeysFor(range, g).map((key) => ({
    key,
    moneyIn: inByBucket.get(key) ?? 0,
    moneyOut: outByBucket.get(key) ?? 0,
  }));

  return { granularity: g, series };
}
