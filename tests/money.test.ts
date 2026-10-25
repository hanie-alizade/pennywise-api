import { describe, it, expect } from 'vitest';
import { parseSqlSum, sqlSum, sqlSumCoalesce } from '../src/lib/money.js';
import { transactions } from '../src/db/schema.js';

describe('Money utility and SQL SUM casting', () => {
  describe('parseSqlSum', () => {
    it('returns null for null or undefined input (representing unset Actual)', () => {
      expect(parseSqlSum(null)).toBeNull();
      expect(parseSqlSum(undefined)).toBeNull();
    });

    it('converts BigInt primitive into a JavaScript number without BigInt serialization issues', () => {
      const bigintVal = BigInt(1250);
      const result = parseSqlSum(bigintVal);
      expect(typeof result).toBe('number');
      expect(result).toBe(1250);
      // Ensures it can be JSON serialized without throwing "Do not know how to serialize a BigInt"
      expect(JSON.stringify({ actual: result })).toBe('{"actual":1250}');
    });

    it('converts Postgres numeric string into a JavaScript number', () => {
      const strVal = '98500';
      const result = parseSqlSum(strVal);
      expect(typeof result).toBe('number');
      expect(result).toBe(98500);
    });

    it('preserves existing number values including 0', () => {
      expect(parseSqlSum(0)).toBe(0);
      expect(parseSqlSum(450)).toBe(450);
    });

    it('handles large financial sums within safe JS integer range', () => {
      const largeAmount = BigInt('50000000000'); // 500 million MYR in sen
      const result = parseSqlSum(largeAmount);
      expect(typeof result).toBe('number');
      expect(result).toBe(50000000000);
    });

    it('returns null for invalid non-numeric strings or NaN', () => {
      expect(parseSqlSum('invalid')).toBeNull();
      expect(parseSqlSum(NaN)).toBeNull();
    });
  });

  describe('Drizzle SQL SUM expressions', () => {
    it('constructs cast(sum(...) as bigint) expression', () => {
      const expr = sqlSum(transactions.amount);
      expect(expr).toBeDefined();
    });

    it('constructs coalesce(cast(sum(...) as bigint), 0) expression', () => {
      const expr = sqlSumCoalesce(transactions.amount);
      expect(expr).toBeDefined();
    });
  });
});
