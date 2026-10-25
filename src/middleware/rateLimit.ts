import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rateLimits } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  action: string;
}

export function createRateLimiter(options: RateLimitOptions) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    // In test environment, skip rate limiting unless specifically testing rate limits
    if (env.NODE_ENV === 'test' && !req.headers['x-test-rate-limit']) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `ratelimit:${options.action}:${ip}`;
    const now = new Date();

    try {
      const existing = await db.query.rateLimits.findFirst({
        where: eq(rateLimits.key, key),
      });

      if (existing) {
        if (new Date(existing.expiresAt) > now) {
          if (existing.count >= options.max) {
            throw AppError.rateLimited();
          }

          await db
            .update(rateLimits)
            .set({ count: existing.count + 1 })
            .where(eq(rateLimits.key, key));

          return next();
        }

        // Expired window, reset
        const expiresAt = new Date(now.getTime() + options.windowMs);
        await db.update(rateLimits).set({ count: 1, expiresAt }).where(eq(rateLimits.key, key));

        return next();
      }

      // New record
      const expiresAt = new Date(now.getTime() + options.windowMs);
      await db.insert(rateLimits).values({
        key,
        count: 1,
        expiresAt,
      });

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
