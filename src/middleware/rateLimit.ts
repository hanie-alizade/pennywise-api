import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { sql, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rateLimits } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  action: string;
  keyGenerator?: (req: Request) => string | null;
}

export function hashRateLimitIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createRateLimiter(options: RateLimitOptions) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    // In test environment, skip rate limiting unless specifically testing rate limits
    if (env.NODE_ENV === 'test' && !req.headers['x-test-rate-limit']) {
      return next();
    }

    const customKey = options.keyGenerator ? options.keyGenerator(req) : null;
    // If a keyGenerator is provided and returns null (e.g. invalid/missing body value), skip this specific limiter
    if (options.keyGenerator && !customKey) {
      return next();
    }

    const identifier = customKey ?? (req.ip || req.socket.remoteAddress || 'unknown');
    const key = `ratelimit:${options.action}:${identifier}`;
    const windowInterval = `${Math.ceil(options.windowMs / 1000)} seconds`;

    try {
      // 1. Probabilistic cleanup (~2% of requests) to cheaply prune expired rows
      // Uses the existing index on rate_limits.expires_at without background cron jobs
      if (Math.random() < 0.02) {
        db.delete(rateLimits)
          .where(lt(rateLimits.expiresAt, new Date()))
          .catch((err) => {
            console.error('Rate limit cleanup error:', err);
          });
      }

      // 2. Atomic UPSERT and increment:
      // If the row exists and has expired, reset count to 1 and advance expires_at.
      // If the row exists and is active, increment count.
      // If the row does not exist, insert count 1.
      const [record] = await db
        .insert(rateLimits)
        .values({
          key,
          count: 1,
          expiresAt: sql`now() + ${sql.raw(`interval '${windowInterval}'`)}`,
        })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            count: sql`CASE WHEN ${rateLimits.expiresAt} <= now() THEN 1 ELSE ${rateLimits.count} + 1 END`,
            expiresAt: sql`CASE WHEN ${rateLimits.expiresAt} <= now() THEN now() + ${sql.raw(`interval '${windowInterval}'`)} ELSE ${rateLimits.expiresAt} END`,
          },
        })
        .returning({
          count: rateLimits.count,
        });

      if (record && record.count > options.max) {
        throw AppError.rateLimited();
      }

      next();
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      // If DB error happens during rate limiting, log and allow request through to prevent total outage
      console.error('Rate limiting error:', err);
      next();
    }
  };
}
