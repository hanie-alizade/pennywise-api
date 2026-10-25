import { z } from 'zod';

export const yearMonthSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60, 'Name must not exceed 60 characters'),
  type: z.enum(['income', 'expense']),
  sortOrder: z.number().int().optional(),
  addToMonth: yearMonthSchema.optional(),
});

export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

export const categoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    sortOrder: z.number().int().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined || data.sortOrder !== undefined || data.archived !== undefined,
    { message: 'At least one property must be provided to update' }
  );

export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

export const subcategoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60, 'Name must not exceed 60 characters'),
  sortOrder: z.number().int().optional(),
  addToMonth: yearMonthSchema.optional(),
});

export type SubcategoryCreateInput = z.infer<typeof subcategoryCreateSchema>;
