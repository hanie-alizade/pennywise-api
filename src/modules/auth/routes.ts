import { Router, type Router as ExpressRouter } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { createRateLimiter, hashRateLimitIdentifier } from '../../middleware/rateLimit.js';
import { authMiddleware } from '../../middleware/auth.js';
import { credentialsSchema, refreshTokenSchema } from './schemas.js';
import * as authService from './service.js';

export const authRouter: ExpressRouter = Router();

// POST /auth/register: IP-based limiter (10 attempts / 15 min)
authRouter.post(
  '/auth/register',
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, action: 'register:ip' }),
  validateBody(credentialsSchema),
  async (req, res, next) => {
    try {
      const result = await authService.register(req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /auth/login: Dual limiter
// 1. IP limiter: max 10 attempts per 15 min per IP (protects against distributed noise from single IP)
// 2. Account limiter: max 20 attempts per 15 min per hashed email (protects against rotating IPs brute-forcing one account)
// Trade-off: An attacker with rotating IPs can intentionally trigger the account limiter to lock out a target
// user for up to 15 minutes (denial-of-service). A threshold of 20 attempts balances brute-force friction
// against accidental lockouts from typos or distributed attacks.
authRouter.post(
  '/auth/login',
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, action: 'login:ip' }),
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    action: 'login:account',
    keyGenerator: (req) => {
      const email = req.body?.email;
      if (typeof email !== 'string') return null;
      const normalized = email.trim().toLowerCase();
      // Ignore overly long inputs (RFC 5321 max is 254 chars); let validation/IP limiter handle them
      if (normalized.length === 0 || normalized.length > 254) return null;
      // Never store raw email in the rate_limits table; store SHA-256 hash
      return hashRateLimitIdentifier(normalized);
    },
  }),
  validateBody(credentialsSchema),
  async (req, res, next) => {
    try {
      const result = await authService.login(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /auth/refresh
authRouter.post(
  '/auth/refresh',
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, action: 'refresh' }),
  validateBody(refreshTokenSchema),
  async (req, res, next) => {
    try {
      const result = await authService.refresh(req.body.refreshToken);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /auth/logout
authRouter.post('/auth/logout', validateBody(refreshTokenSchema), async (req, res, next) => {
  try {
    await authService.logout(req.body.refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /me
authRouter.get('/me', authMiddleware, (req, res) => {
  res.status(200).json({
    user: req.user,
    workspace: req.workspace,
  });
});
