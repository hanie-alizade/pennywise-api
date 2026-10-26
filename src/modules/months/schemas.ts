import { z } from 'zod';
import { yearMonthSchema } from '../categories/schemas.js';

export const monthCreateSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  copyFrom: yearMonthSchema.optional(),
});

export type MonthCreateInput = z.infer<typeof monthCreateSchema>;

export const lineCreateSchema = z
  .object({
    categoryId: z.string().uuid('Invalid categoryId format').optional(),
    subcategoryId: z.string().uuid('Invalid subcategoryId format').optional(),
    expected: z.number().int().min(0, 'Expected amount must be non-negative').nullable().optional(),
  })
  .refine(
    (data) =>
      (Boolean(data.categoryId) && !data.subcategoryId) ||
      (!data.categoryId && Boolean(data.subcategoryId)),
    {
      message: 'Exactly one of categoryId or subcategoryId must be provided',
    }
  );

export type LineCreateInput = z.infer<typeof lineCreateSchema>;

export const lineUpdateSchema = z.object({
  expected: z.number().int().min(0, 'Expected amount must be non-negative').nullable(),
});

export type LineUpdateInput = z.infer<typeof lineUpdateSchema>;

export const monthParamsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});
