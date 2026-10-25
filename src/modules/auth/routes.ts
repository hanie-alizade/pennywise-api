import { Router, type Router as ExpressRouter } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { createRateLimiter } from '../../middleware/rateLimit.js';
import { authMiddleware } from '../../middleware/auth.js';
import { credentialsSchema, refreshTokenSchema } from './schemas.js';
import * as authService from './service.js';

export const authRouter: ExpressRouter = Router();

// POST /auth/register
authRouter.post(
  '/auth/register',
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, action: 'register' }),
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

// POST /auth/login
authRouter.post(
  '/auth/login',
  createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, action: 'login' }),
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
