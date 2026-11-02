import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { transactionCreateSchema, transactionUpdateSchema } from './schemas.js';
import * as transactionsService from './service.js';

export const transactionsRouter: ExpressRouter = Router();

const uuidParamSchema = z.string().uuid('Invalid ID parameter');

// GET /budget-lines/:id/transactions
transactionsRouter.get('/budget-lines/:id/transactions', authMiddleware, async (req, res, next) => {
  try {
    const idParsed = uuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return next(idParsed.error);
    }
    const result = await transactionsService.listTransactions(req.workspace!.id, idParsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /budget-lines/:id/transactions
transactionsRouter.post(
  '/budget-lines/:id/transactions',
  authMiddleware,
  validateBody(transactionCreateSchema),
  async (req, res, next) => {
    try {
      const idParsed = uuidParamSchema.safeParse(req.params.id);
      if (!idParsed.success) {
        return next(idParsed.error);
      }
      const result = await transactionsService.createTransaction(
        req.workspace!.id,
        req.user!.id,
        idParsed.data,
        req.body
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /transactions/:id
transactionsRouter.patch(
  '/transactions/:id',
  authMiddleware,
  validateBody(transactionUpdateSchema),
  async (req, res, next) => {
    try {
      const idParsed = uuidParamSchema.safeParse(req.params.id);
      if (!idParsed.success) {
        return next(idParsed.error);
      }
      const result = await transactionsService.updateTransaction(
        req.workspace!.id,
        idParsed.data,
        req.body
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /transactions/:id
transactionsRouter.delete('/transactions/:id', authMiddleware, async (req, res, next) => {
  try {
    const idParsed = uuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return next(idParsed.error);
    }
    await transactionsService.deleteTransaction(req.workspace!.id, idParsed.data);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
