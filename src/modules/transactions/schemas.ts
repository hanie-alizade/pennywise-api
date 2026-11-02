import { z } from 'zod';
import { localDateSchema } from '../../lib/dates.js';

export const transactionCreateSchema = z.object({
  amount: z.number().int().min(1, 'Amount must be a positive integer in minor units'),
  date: localDateSchema,
});

export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;

export const transactionUpdateSchema = z
  .object({
    amount: z.number().int().min(1, 'Amount must be a positive integer in minor units').optional(),
    date: localDateSchema.optional(),
  })
  .refine((data) => data.amount !== undefined || data.date !== undefined, {
    message: 'At least one of amount or date must be provided',
  });

export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>;
