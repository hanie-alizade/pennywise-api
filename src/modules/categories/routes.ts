import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { categoryCreateSchema, categoryUpdateSchema, subcategoryCreateSchema } from './schemas.js';
import * as categoriesService from './service.js';

export const categoriesRouter: ExpressRouter = Router();

const uuidParamSchema = z.string().uuid('Invalid ID parameter');

// GET /categories
categoriesRouter.get('/categories', authMiddleware, async (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const result = await categoriesService.listCategories(req.workspace!.id, includeArchived);
    res.status(200).json({ categories: result });
  } catch (err) {
    next(err);
  }
});

// POST /categories
categoriesRouter.post(
  '/categories',
  authMiddleware,
  validateBody(categoryCreateSchema),
  async (req, res, next) => {
    try {
      const result = await categoriesService.createCategory(req.workspace!.id, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /categories/:id
categoriesRouter.patch(
  '/categories/:id',
  authMiddleware,
  validateBody(categoryUpdateSchema),
  async (req, res, next) => {
    try {
      const idParse = uuidParamSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return next(idParse.error);
      }
      const result = await categoriesService.updateCategory(
        req.workspace!.id,
        idParse.data,
        req.body
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /categories/:id/subcategories
categoriesRouter.post(
  '/categories/:id/subcategories',
  authMiddleware,
  validateBody(subcategoryCreateSchema),
  async (req, res, next) => {
    try {
      const idParse = uuidParamSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return next(idParse.error);
      }
      const result = await categoriesService.createSubcategory(
        req.workspace!.id,
        idParse.data,
        req.body
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /subcategories/:id
categoriesRouter.patch(
  '/subcategories/:id',
  authMiddleware,
  validateBody(categoryUpdateSchema),
  async (req, res, next) => {
    try {
      const idParse = uuidParamSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return next(idParse.error);
      }
      const result = await categoriesService.updateSubcategory(
        req.workspace!.id,
        idParse.data,
        req.body
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);
