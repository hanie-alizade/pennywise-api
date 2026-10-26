import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import {
  monthCreateSchema,
  lineCreateSchema,
  lineUpdateSchema,
  monthParamsSchema,
} from './schemas.js';
import * as monthsService from './service.js';

export const monthsRouter: ExpressRouter = Router();

const uuidParamSchema = z.string().uuid('Invalid ID parameter');

// GET /months
monthsRouter.get('/months', authMiddleware, async (req, res, next) => {
  try {
    const result = await monthsService.listMonths(req.workspace!.id);
    res.status(200).json({ months: result });
  } catch (err) {
    next(err);
  }
});

// POST /months
monthsRouter.post(
  '/months',
  authMiddleware,
  validateBody(monthCreateSchema),
  async (req, res, next) => {
    try {
      const result = await monthsService.createMonth(req.workspace!.id, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /months/:year/:month
monthsRouter.get('/months/:year/:month', authMiddleware, async (req, res, next) => {
  try {
    const paramsParsed = monthParamsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      return next(paramsParsed.error);
    }
    const result = await monthsService.computeMonthView(
      req.workspace!.id,
      paramsParsed.data.year,
      paramsParsed.data.month
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /months/:year/:month/lines
monthsRouter.post(
  '/months/:year/:month/lines',
  authMiddleware,
  validateBody(lineCreateSchema),
  async (req, res, next) => {
    try {
      const paramsParsed = monthParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        return next(paramsParsed.error);
      }
      const result = await monthsService.addLineToMonth(
        req.workspace!.id,
        paramsParsed.data.year,
        paramsParsed.data.month,
        req.body
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /budget-lines/:id
monthsRouter.patch(
  '/budget-lines/:id',
  authMiddleware,
  validateBody(lineUpdateSchema),
  async (req, res, next) => {
    try {
      const idParsed = uuidParamSchema.safeParse(req.params.id);
      if (!idParsed.success) {
        return next(idParsed.error);
      }
      const result = await monthsService.updateLine(req.workspace!.id, idParsed.data, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /budget-lines/:id
monthsRouter.delete('/budget-lines/:id', authMiddleware, async (req, res, next) => {
  try {
    const idParsed = uuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return next(idParsed.error);
    }
    await monthsService.deleteLine(req.workspace!.id, idParsed.data);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
