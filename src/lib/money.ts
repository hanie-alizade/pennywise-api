import { type SQL, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';

/**
 * Ensures a database SUM() result is safely cast and parsed into a JavaScript number.
 * Postgres returns `bigint` for SUM() on integers/bigints, which drivers (like pg/Neon)
 * often serialize as strings (e.g. "1250") or bigint primitives.
 */
export function parseSqlSum(val: unknown): number | null {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'bigint') {
    return Number(val);
  }
  if (typeof val === 'string') {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Generates a Drizzle SQL expression that calculates SUM(column) as a coerced bigint/number.
 */
export function sqlSum(column: AnyColumn): SQL<number | null> {
  return sql<number | null>`cast(sum(${column}) as bigint)`;
}

/**
 * Generates a Drizzle SQL expression that calculates COALESCE(SUM(column), 0).
 */
export function sqlSumCoalesce(column: AnyColumn): SQL<number> {
  return sql<number>`coalesce(cast(sum(${column}) as bigint), 0)`;
}
