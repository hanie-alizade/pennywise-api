import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { transactions, budgetLines, months } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { parseSqlSum } from '../../lib/money.js';
import { parseCalendarDate } from '../../lib/dates.js';
import type { TransactionCreateInput, TransactionUpdateInput } from './schemas.js';

export interface TransactionResponse {
  id: string;
  budgetLineId: string;
  amount: number;
  date: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionListResponse {
  total: number;
  transactions: TransactionResponse[];
}

function formatTransaction(tx: typeof transactions.$inferSelect): TransactionResponse {
  return {
    id: tx.id,
    budgetLineId: tx.budgetLineId,
    amount: tx.amount,
    date: tx.transactionDate,
    createdBy: tx.createdBy ?? '',
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };
}

export async function listTransactions(
  workspaceId: string,
  budgetLineId: string
): Promise<TransactionListResponse> {
  const line = await db.query.budgetLines.findFirst({
    where: and(eq(budgetLines.id, budgetLineId), eq(budgetLines.workspaceId, workspaceId)),
  });

  if (!line) {
    throw AppError.notFound('Budget line not found');
  }

  const txList = await db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.budgetLineId, budgetLineId), eq(transactions.workspaceId, workspaceId))
    )
    .orderBy(desc(transactions.transactionDate), desc(transactions.createdAt));

  const [totalRow] = await db
    .select({
      total: sql<number | null>`cast(sum(${transactions.amount}) as bigint)`,
    })
    .from(transactions)
    .where(
      and(eq(transactions.budgetLineId, budgetLineId), eq(transactions.workspaceId, workspaceId))
    );

  const total = parseSqlSum(totalRow?.total) ?? 0;

  return {
    total,
    transactions: txList.map(formatTransaction),
  };
}

export async function createTransaction(
  workspaceId: string,
  userId: string,
  budgetLineId: string,
  input: TransactionCreateInput
): Promise<TransactionResponse> {
  // Line must exist and belong to the workspace
  const line = await db.query.budgetLines.findFirst({
    where: and(eq(budgetLines.id, budgetLineId), eq(budgetLines.workspaceId, workspaceId)),
  });

  if (!line) {
    throw AppError.notFound('Budget line not found');
  }

  // Only leaf lines accept transactions: if category has subcategories, category-level line cannot take transactions
  if (line.subcategoryId === null) {
    // Check if category has subcategories
    const [subCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.monthId, line.monthId),
          eq(budgetLines.categoryId, line.categoryId),
          sql`${budgetLines.subcategoryId} IS NOT NULL`
        )
      );

    if (subCount && subCount.count > 0) {
      throw AppError.unprocessable('Only leaf lines accept transactions', 'NOT_A_LEAF_LINE');
    }
  }

  // Month rule: transaction date year and month must match the line's month
  const month = await db.query.months.findFirst({
    where: eq(months.id, line.monthId),
  });

  if (!month) {
    throw AppError.notFound('Month not found');
  }

  const dateParts = parseCalendarDate(input.date);
  if (dateParts.year !== month.year || dateParts.month !== month.month) {
    throw AppError.unprocessable(
      `Transaction date (${input.date}) must fall in the same month as the budget line (${month.year}-${String(month.month).padStart(2, '0')})`,
      'TRANSACTION_DATE_OUTSIDE_MONTH'
    );
  }

  const [newTx] = await db
    .insert(transactions)
    .values({
      workspaceId,
      budgetLineId,
      amount: input.amount,
      transactionDate: input.date,
      createdBy: userId,
    })
    .returning();

  return formatTransaction(newTx);
}

export async function updateTransaction(
  workspaceId: string,
  transactionId: string,
  input: TransactionUpdateInput
): Promise<TransactionResponse> {
  const tx = await db.query.transactions.findFirst({
    where: and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId)),
  });

  if (!tx) {
    throw AppError.notFound('Transaction not found');
  }

  // If date is being updated, enforce same-month rule
  if (input.date !== undefined && input.date !== tx.transactionDate) {
    const line = await db.query.budgetLines.findFirst({
      where: eq(budgetLines.id, tx.budgetLineId),
    });

    if (!line) {
      throw AppError.notFound('Budget line not found');
    }

    const month = await db.query.months.findFirst({
      where: eq(months.id, line.monthId),
    });

    if (!month) {
      throw AppError.notFound('Month not found');
    }

    const dateParts = parseCalendarDate(input.date);
    if (dateParts.year !== month.year || dateParts.month !== month.month) {
      throw AppError.unprocessable(
        `Transaction date (${input.date}) must fall in the same month as the budget line (${month.year}-${String(month.month).padStart(2, '0')})`,
        'TRANSACTION_DATE_OUTSIDE_MONTH'
      );
    }
  }

  const [updated] = await db
    .update(transactions)
    .set({
      amount: input.amount !== undefined ? input.amount : tx.amount,
      transactionDate: input.date !== undefined ? input.date : tx.transactionDate,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId)))
    .returning();

  return formatTransaction(updated);
}

export async function deleteTransaction(workspaceId: string, transactionId: string): Promise<void> {
  const tx = await db.query.transactions.findFirst({
    where: and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId)),
  });

  if (!tx) {
    throw AppError.notFound('Transaction not found');
  }

  await db
    .delete(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId)));
}
