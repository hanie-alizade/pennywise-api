import { eq, and, isNull, inArray, sql, desc, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  months,
  workspaces,
  categories,
  subcategories,
  budgetLines,
  transactions,
} from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { parseSqlSum } from '../../lib/money.js';
import type { MonthCreateInput, LineCreateInput, LineUpdateInput } from './schemas.js';

export interface LineRow {
  lineId: string;
  subcategoryId: string | null;
  name: string;
  archived: boolean;
  expected: number | null;
  actual: number | null;
  transactionCount: number;
}

export interface CategoryRow {
  categoryId: string;
  name: string;
  archived: boolean;
  hasSubcategories: boolean;
  expected: number | null;
  actual: number | null;
  expectedIsComputed: boolean;
  lineId: string | null;
  transactionCount: number;
  children: LineRow[];
}

export interface SectionTotals {
  expected: number;
  actual: number;
  difference: number;
  hasAnyActual: boolean;
}

export interface Section {
  totals: SectionTotals;
  categories: CategoryRow[];
}

export interface MonthView {
  id: string;
  year: number;
  month: number;
  currency: string;
  income: Section;
  expense: Section;
  net: {
    expected: number;
    actual: number;
  };
}

export async function listMonths(workspaceId: string) {
  const result = await db
    .select({
      id: months.id,
      year: months.year,
      month: months.month,
    })
    .from(months)
    .where(eq(months.workspaceId, workspaceId))
    .orderBy(desc(months.year), desc(months.month));

  return result;
}

export async function createMonth(
  workspaceId: string,
  input: MonthCreateInput
): Promise<MonthView> {
  // Check if month already exists
  const existing = await db.query.months.findFirst({
    where: and(
      eq(months.workspaceId, workspaceId),
      eq(months.year, input.year),
      eq(months.month, input.month)
    ),
  });

  if (existing) {
    throw AppError.conflict('Month already exists', 'MONTH_EXISTS');
  }

  let sourceMonthId: string | null = null;
  if (input.copyFrom) {
    const sourceMonth = await db.query.months.findFirst({
      where: and(
        eq(months.workspaceId, workspaceId),
        eq(months.year, input.copyFrom.year),
        eq(months.month, input.copyFrom.month)
      ),
    });

    if (!sourceMonth) {
      throw AppError.notFound('Source month to copy from does not exist');
    }
    sourceMonthId = sourceMonth.id;
  }

  await db.transaction(async (tx) => {
    // 1. Create target month
    const [newMonth] = await tx
      .insert(months)
      .values({
        workspaceId,
        year: input.year,
        month: input.month,
      })
      .returning();

    // 2. Query all active categories and all subcategories in workspace
    const allCategories = await tx
      .select()
      .from(categories)
      .where(eq(categories.workspaceId, workspaceId));

    const allSubcategories = await tx
      .select()
      .from(subcategories)
      .where(eq(subcategories.workspaceId, workspaceId));

    // A category is a parent if it has any subcategory (once a parent, always a parent in MVP)
    const parentCategoryIds = new Set(allSubcategories.map((s) => s.categoryId));

    // Active leaves
    interface ActiveLeaf {
      categoryId: string;
      subcategoryId: string | null;
    }
    const activeLeaves: ActiveLeaf[] = [];

    // Active leaf categories (not archived, and has no subcategories)
    for (const cat of allCategories) {
      if (cat.archivedAt === null && !parentCategoryIds.has(cat.id)) {
        activeLeaves.push({ categoryId: cat.id, subcategoryId: null });
      }
    }

    // Active leaf subcategories (subcat active AND parent category active)
    const activeCategoryIds = new Set(
      allCategories.filter((c) => c.archivedAt === null).map((c) => c.id)
    );
    for (const sub of allSubcategories) {
      if (sub.archivedAt === null && activeCategoryIds.has(sub.categoryId)) {
        activeLeaves.push({ categoryId: sub.categoryId, subcategoryId: sub.id });
      }
    }

    // 3. Populate lines for the new month
    if (!sourceMonthId) {
      // Without copyFrom: one line per active leaf with expectedAmount = null
      if (activeLeaves.length > 0) {
        await tx.insert(budgetLines).values(
          activeLeaves.map((leaf) => ({
            workspaceId,
            monthId: newMonth.id,
            categoryId: leaf.categoryId,
            subcategoryId: leaf.subcategoryId,
            expectedAmount: null,
          }))
        );
      }
    } else {
      // With copyFrom: copy expected amounts for active leaves from source month
      const sourceLines = await tx
        .select({
          categoryId: budgetLines.categoryId,
          subcategoryId: budgetLines.subcategoryId,
          expectedAmount: budgetLines.expectedAmount,
        })
        .from(budgetLines)
        .where(eq(budgetLines.monthId, sourceMonthId));

      const sourceExpectedMap = new Map<string, number | null>();
      for (const line of sourceLines) {
        const key = `${line.categoryId}:${line.subcategoryId ?? 'null'}`;
        sourceExpectedMap.set(key, line.expectedAmount);
      }

      if (activeLeaves.length > 0) {
        await tx.insert(budgetLines).values(
          activeLeaves.map((leaf) => {
            const key = `${leaf.categoryId}:${leaf.subcategoryId ?? 'null'}`;
            const copiedExpected = sourceExpectedMap.get(key) ?? null;
            return {
              workspaceId,
              monthId: newMonth.id,
              categoryId: leaf.categoryId,
              subcategoryId: leaf.subcategoryId,
              expectedAmount: copiedExpected,
            };
          })
        );
      }
    }
  });

  // 4. Return computed month view after transaction commits
  return await computeMonthView(workspaceId, input.year, input.month);
}

export async function addLineToMonth(
  workspaceId: string,
  year: number,
  monthNum: number,
  input: LineCreateInput
): Promise<MonthView> {
  const month = await db.query.months.findFirst({
    where: and(
      eq(months.workspaceId, workspaceId),
      eq(months.year, year),
      eq(months.month, monthNum)
    ),
  });

  if (!month) {
    throw AppError.notFound('Month not found');
  }

  if (input.categoryId) {
    const category = await db.query.categories.findFirst({
      where: and(eq(categories.id, input.categoryId), eq(categories.workspaceId, workspaceId)),
    });

    if (!category) {
      throw AppError.notFound('Category not found');
    }

    // Check if category has subcategories
    const [subCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subcategories)
      .where(eq(subcategories.categoryId, input.categoryId));

    if (subCount && subCount.count > 0) {
      throw AppError.unprocessable(
        'A category that has subcategories cannot get its own line',
        'CATEGORY_HAS_SUBCATEGORIES'
      );
    }

    // Check if line already exists
    const existingLine = await db.query.budgetLines.findFirst({
      where: and(
        eq(budgetLines.monthId, month.id),
        eq(budgetLines.categoryId, input.categoryId),
        isNull(budgetLines.subcategoryId)
      ),
    });

    if (existingLine) {
      throw AppError.conflict('Line already exists for this category in this month', 'LINE_EXISTS');
    }

    await db.insert(budgetLines).values({
      workspaceId,
      monthId: month.id,
      categoryId: input.categoryId,
      subcategoryId: null,
      expectedAmount: input.expected ?? null,
    });
  } else if (input.subcategoryId) {
    const sub = await db.query.subcategories.findFirst({
      where: and(
        eq(subcategories.id, input.subcategoryId),
        eq(subcategories.workspaceId, workspaceId)
      ),
    });

    if (!sub) {
      throw AppError.notFound('Subcategory not found');
    }

    // Check if line already exists
    const existingLine = await db.query.budgetLines.findFirst({
      where: and(
        eq(budgetLines.monthId, month.id),
        eq(budgetLines.subcategoryId, input.subcategoryId)
      ),
    });

    if (existingLine) {
      throw AppError.conflict(
        'Line already exists for this subcategory in this month',
        'LINE_EXISTS'
      );
    }

    await db.insert(budgetLines).values({
      workspaceId,
      monthId: month.id,
      categoryId: sub.categoryId,
      subcategoryId: sub.id,
      expectedAmount: input.expected ?? null,
    });
  }

  return await computeMonthView(workspaceId, year, monthNum);
}

export async function updateLine(
  workspaceId: string,
  lineId: string,
  input: LineUpdateInput
): Promise<LineRow> {
  const line = await db.query.budgetLines.findFirst({
    where: and(eq(budgetLines.id, lineId), eq(budgetLines.workspaceId, workspaceId)),
  });

  if (!line) {
    throw AppError.notFound('Budget line not found');
  }

  const [updated] = await db
    .update(budgetLines)
    .set({
      expectedAmount: input.expected,
      updatedAt: new Date(),
    })
    .where(and(eq(budgetLines.id, lineId), eq(budgetLines.workspaceId, workspaceId)))
    .returning();

  // Get transactions actual and count
  const [txSummary] = await db
    .select({
      txCount: sql<number>`count(*)::int`,
      totalAmount: sql<number | null>`cast(sum(${transactions.amount}) as bigint)`,
    })
    .from(transactions)
    .where(eq(transactions.budgetLineId, lineId));

  const count = txSummary?.txCount ?? 0;
  const actual = count > 0 ? parseSqlSum(txSummary?.totalAmount) : null;

  // Resolve name and archived status
  let name: string;
  let archived: boolean;

  if (updated.subcategoryId) {
    const sub = await db.query.subcategories.findFirst({
      where: eq(subcategories.id, updated.subcategoryId),
    });
    name = sub ? sub.name : '';
    archived = sub ? sub.archivedAt !== null : false;
  } else {
    const cat = await db.query.categories.findFirst({
      where: eq(categories.id, updated.categoryId),
    });
    name = cat ? cat.name : '';
    archived = cat ? cat.archivedAt !== null : false;
  }

  return {
    lineId: updated.id,
    subcategoryId: updated.subcategoryId,
    name,
    archived,
    expected: updated.expectedAmount,
    actual,
    transactionCount: count,
  };
}

export async function deleteLine(workspaceId: string, lineId: string): Promise<void> {
  const line = await db.query.budgetLines.findFirst({
    where: and(eq(budgetLines.id, lineId), eq(budgetLines.workspaceId, workspaceId)),
  });

  if (!line) {
    throw AppError.notFound('Budget line not found');
  }

  // Check transactions
  const [txCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(eq(transactions.budgetLineId, lineId));

  if (txCount && txCount.count > 0) {
    throw AppError.conflict('Cannot delete a line that has transactions', 'LINE_HAS_TRANSACTIONS');
  }

  await db
    .delete(budgetLines)
    .where(and(eq(budgetLines.id, lineId), eq(budgetLines.workspaceId, workspaceId)));
}

export async function computeMonthView(
  workspaceId: string,
  year: number,
  monthNum: number
): Promise<MonthView> {
  const month = await db.query.months.findFirst({
    where: and(
      eq(months.workspaceId, workspaceId),
      eq(months.year, year),
      eq(months.month, monthNum)
    ),
  });

  if (!month) {
    throw AppError.notFound('Month not found');
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  const currency = workspace ? workspace.currency : 'MYR';

  // Query all budget lines in this month
  const lines = await db
    .select({
      id: budgetLines.id,
      monthId: budgetLines.monthId,
      categoryId: budgetLines.categoryId,
      subcategoryId: budgetLines.subcategoryId,
      expectedAmount: budgetLines.expectedAmount,
      catName: categories.name,
      catType: categories.type,
      catSortOrder: categories.sortOrder,
      catArchivedAt: categories.archivedAt,
      subName: subcategories.name,
      subSortOrder: subcategories.sortOrder,
      subArchivedAt: subcategories.archivedAt,
    })
    .from(budgetLines)
    .innerJoin(categories, eq(budgetLines.categoryId, categories.id))
    .leftJoin(subcategories, eq(budgetLines.subcategoryId, subcategories.id))
    .where(eq(budgetLines.monthId, month.id))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  const lineIds = lines.map((l) => l.id);

  // Query transaction totals per line
  const txSummaryMap = new Map<string, { txCount: number; totalAmount: number }>();
  if (lineIds.length > 0) {
    const txSums = await db
      .select({
        budgetLineId: transactions.budgetLineId,
        txCount: sql<number>`count(*)::int`,
        totalAmount: sql<number | null>`cast(sum(${transactions.amount}) as bigint)`,
      })
      .from(transactions)
      .where(inArray(transactions.budgetLineId, lineIds))
      .groupBy(transactions.budgetLineId);

    for (const row of txSums) {
      txSummaryMap.set(row.budgetLineId, {
        txCount: row.txCount,
        totalAmount: parseSqlSum(row.totalAmount) ?? 0,
      });
    }
  }

  // Structure by category
  interface CategoryAccumulator {
    categoryId: string;
    name: string;
    type: 'income' | 'expense';
    sortOrder: number;
    archived: boolean;
    ownLine: (typeof lines)[0] | null;
    childrenLines: (typeof lines)[0][];
  }

  const categoryMap = new Map<string, CategoryAccumulator>();
  for (const line of lines) {
    let catEntry = categoryMap.get(line.categoryId);
    if (!catEntry) {
      catEntry = {
        categoryId: line.categoryId,
        name: line.catName,
        type: line.catType as 'income' | 'expense',
        sortOrder: line.catSortOrder,
        archived: line.catArchivedAt !== null,
        ownLine: null,
        childrenLines: [],
      };
      categoryMap.set(line.categoryId, catEntry);
    }

    if (line.subcategoryId === null) {
      catEntry.ownLine = line;
    } else {
      catEntry.childrenLines.push(line);
    }
  }

  interface BuiltCategoryRow extends CategoryRow {
    type: 'income' | 'expense';
    sortOrder: number;
  }

  const builtCategoryRows: BuiltCategoryRow[] = [];

  for (const cat of categoryMap.values()) {
    const hasSubcategories = cat.childrenLines.length > 0;

    if (!hasSubcategories && cat.ownLine) {
      const stats = txSummaryMap.get(cat.ownLine.id) ?? { txCount: 0, totalAmount: 0 };
      const actual = stats.txCount > 0 ? stats.totalAmount : null;

      builtCategoryRows.push({
        categoryId: cat.categoryId,
        name: cat.name,
        archived: cat.archived,
        hasSubcategories: false,
        expected: cat.ownLine.expectedAmount,
        actual,
        expectedIsComputed: false,
        lineId: cat.ownLine.id,
        transactionCount: stats.txCount,
        children: [],
        type: cat.type,
        sortOrder: cat.sortOrder,
      });
    } else {
      // Sort children by sortOrder ASC, name ASC
      cat.childrenLines.sort((a, b) => {
        const orderDiff = (a.subSortOrder ?? 0) - (b.subSortOrder ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return (a.subName ?? '').localeCompare(b.subName ?? '');
      });

      const children: LineRow[] = cat.childrenLines.map((child) => {
        const stats = txSummaryMap.get(child.id) ?? { txCount: 0, totalAmount: 0 };
        const actual = stats.txCount > 0 ? stats.totalAmount : null;
        return {
          lineId: child.id,
          subcategoryId: child.subcategoryId,
          name: child.subName ?? '',
          archived: child.subArchivedAt !== null,
          expected: child.expectedAmount,
          actual,
          transactionCount: stats.txCount,
        };
      });

      // Expected is null only if all children expected are null; otherwise sum non-null expected
      const hasAnyExpected = children.some((c) => c.expected !== null);
      const computedExpected = hasAnyExpected
        ? children.reduce((sum, c) => sum + (c.expected ?? 0), 0)
        : null;

      // Actual is null only if all children actual are null; otherwise sum non-null actuals
      const hasAnyActual = children.some((c) => c.actual !== null);
      const computedActual = hasAnyActual
        ? children.reduce((sum, c) => sum + (c.actual ?? 0), 0)
        : null;

      const totalTxCount = children.reduce((sum, c) => sum + c.transactionCount, 0);

      builtCategoryRows.push({
        categoryId: cat.categoryId,
        name: cat.name,
        archived: cat.archived,
        hasSubcategories: true,
        expected: computedExpected,
        actual: computedActual,
        expectedIsComputed: true,
        lineId: null,
        transactionCount: totalTxCount,
        children,
        type: cat.type,
        sortOrder: cat.sortOrder,
      });
    }
  }

  // Separate income and expense categories, sorted by sortOrder ASC, name ASC
  const incomeCats = builtCategoryRows
    .filter((c) => c.type === 'income')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const expenseCats = builtCategoryRows
    .filter((c) => c.type === 'expense')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  // Compute section totals using LEAF lines only (anti double-counting)
  function computeSectionTotals(catRows: BuiltCategoryRow[], isExpense: boolean): SectionTotals {
    let expectedSum = 0;
    let actualSum = 0;
    let hasAnyActual = false;

    for (const cat of catRows) {
      if (cat.hasSubcategories) {
        for (const child of cat.children) {
          expectedSum += child.expected ?? 0;
          if (child.actual !== null) {
            actualSum += child.actual;
            hasAnyActual = true;
          }
        }
      } else {
        expectedSum += cat.expected ?? 0;
        if (cat.actual !== null) {
          actualSum += cat.actual;
          hasAnyActual = true;
        }
      }
    }

    // Expense = expected - actual (positive = remaining, negative = overspent)
    // Income = actual - expected (positive = earned more than planned)
    const difference = isExpense ? expectedSum - actualSum : actualSum - expectedSum;

    return {
      expected: expectedSum,
      actual: actualSum,
      difference,
      hasAnyActual,
    };
  }

  const incomeTotals = computeSectionTotals(incomeCats, false);
  const expenseTotals = computeSectionTotals(expenseCats, true);

  return {
    id: month.id,
    year: month.year,
    month: month.month,
    currency,
    income: {
      totals: incomeTotals,
      categories: incomeCats.map(({ type: _t, sortOrder: _s, ...rest }) => rest),
    },
    expense: {
      totals: expenseTotals,
      categories: expenseCats.map(({ type: _t, sortOrder: _s, ...rest }) => rest),
    },
    net: {
      expected: incomeTotals.expected - expenseTotals.expected,
      actual: incomeTotals.actual - expenseTotals.actual,
    },
  };
}
