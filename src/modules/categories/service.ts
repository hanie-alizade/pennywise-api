import { eq, and, isNull, sql, desc, asc, not } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { categories, subcategories, months, budgetLines, transactions } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import type {
  CategoryCreateInput,
  CategoryUpdateInput,
  SubcategoryCreateInput,
} from './schemas.js';

export async function listCategories(workspaceId: string, includeArchived = false) {
  const categoryFilters = [eq(categories.workspaceId, workspaceId)];
  if (!includeArchived) {
    categoryFilters.push(isNull(categories.archivedAt));
  }

  const allCategories = await db
    .select()
    .from(categories)
    .where(and(...categoryFilters))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  const subcategoryFilters = [eq(subcategories.workspaceId, workspaceId)];
  if (!includeArchived) {
    subcategoryFilters.push(isNull(subcategories.archivedAt));
  }

  const allSubcategories = await db
    .select()
    .from(subcategories)
    .where(and(...subcategoryFilters))
    .orderBy(asc(subcategories.sortOrder), asc(subcategories.name));

  const subcategoriesByCategory = new Map<string, typeof allSubcategories>();
  for (const sub of allSubcategories) {
    const list = subcategoriesByCategory.get(sub.categoryId) ?? [];
    list.push(sub);
    subcategoriesByCategory.set(sub.categoryId, list);
  }

  return allCategories.map((cat) => ({
    id: cat.id,
    name: cat.name,
    type: cat.type as 'income' | 'expense',
    sortOrder: cat.sortOrder,
    archivedAt: cat.archivedAt,
    subcategories: (subcategoriesByCategory.get(cat.id) ?? []).map((sub) => ({
      id: sub.id,
      categoryId: sub.categoryId,
      name: sub.name,
      sortOrder: sub.sortOrder,
      archivedAt: sub.archivedAt,
    })),
  }));
}

export async function createCategory(workspaceId: string, input: CategoryCreateInput) {
  // Check active name conflict
  const existingActive = await db.query.categories.findFirst({
    where: and(
      eq(categories.workspaceId, workspaceId),
      eq(categories.type, input.type),
      isNull(categories.archivedAt),
      sql`lower(${categories.name}) = ${input.name.toLowerCase()}`
    ),
  });

  if (existingActive) {
    throw AppError.conflict('A category with this name already exists', 'NAME_TAKEN');
  }

  // If addToMonth specified, ensure month exists
  let targetMonthId: string | null = null;
  if (input.addToMonth) {
    const targetMonth = await db.query.months.findFirst({
      where: and(
        eq(months.workspaceId, workspaceId),
        eq(months.year, input.addToMonth.year),
        eq(months.month, input.addToMonth.month)
      ),
    });

    if (!targetMonth) {
      throw AppError.notFound('Target month does not exist');
    }
    targetMonthId = targetMonth.id;
  }

  return await db.transaction(async (tx) => {
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [last] = await tx
        .select({ sortOrder: categories.sortOrder })
        .from(categories)
        .where(and(eq(categories.workspaceId, workspaceId), eq(categories.type, input.type)))
        .orderBy(desc(categories.sortOrder))
        .limit(1);
      sortOrder = last ? last.sortOrder + 1 : 0;
    }

    const [newCategory] = await tx
      .insert(categories)
      .values({
        workspaceId,
        name: input.name,
        type: input.type,
        sortOrder,
      })
      .returning();

    if (targetMonthId) {
      await tx.insert(budgetLines).values({
        workspaceId,
        monthId: targetMonthId,
        categoryId: newCategory.id,
        subcategoryId: null,
        expectedAmount: null,
      });
    }

    return {
      id: newCategory.id,
      name: newCategory.name,
      type: newCategory.type as 'income' | 'expense',
      sortOrder: newCategory.sortOrder,
      archivedAt: newCategory.archivedAt,
      subcategories: [],
    };
  });
}

export async function updateCategory(
  workspaceId: string,
  categoryId: string,
  input: CategoryUpdateInput
) {
  const category = await db.query.categories.findFirst({
    where: and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)),
  });

  if (!category) {
    throw AppError.notFound('Category not found');
  }

  const targetName = input.name ?? category.name;
  const isTargetArchived =
    input.archived !== undefined ? input.archived : category.archivedAt !== null;

  // If active, ensure name is not taken by another active category of same type
  if (!isTargetArchived) {
    const nameConflict = await db.query.categories.findFirst({
      where: and(
        eq(categories.workspaceId, workspaceId),
        eq(categories.type, category.type),
        isNull(categories.archivedAt),
        not(eq(categories.id, category.id)),
        sql`lower(${categories.name}) = ${targetName.toLowerCase()}`
      ),
    });

    if (nameConflict) {
      throw AppError.conflict('A category with this name already exists', 'NAME_TAKEN');
    }
  }

  let archivedAt = category.archivedAt;
  if (input.archived === true && category.archivedAt === null) {
    archivedAt = new Date();
  } else if (input.archived === false && category.archivedAt !== null) {
    archivedAt = null;
  }

  const [updated] = await db
    .update(categories)
    .set({
      name: targetName,
      sortOrder: input.sortOrder !== undefined ? input.sortOrder : category.sortOrder,
      archivedAt,
    })
    .where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)))
    .returning();

  const subs = await db
    .select()
    .from(subcategories)
    .where(
      and(eq(subcategories.categoryId, categoryId), eq(subcategories.workspaceId, workspaceId))
    )
    .orderBy(asc(subcategories.sortOrder), asc(subcategories.name));

  return {
    id: updated.id,
    name: updated.name,
    type: updated.type as 'income' | 'expense',
    sortOrder: updated.sortOrder,
    archivedAt: updated.archivedAt,
    subcategories: subs.map((s) => ({
      id: s.id,
      categoryId: s.categoryId,
      name: s.name,
      sortOrder: s.sortOrder,
      archivedAt: s.archivedAt,
    })),
  };
}

export async function createSubcategory(
  workspaceId: string,
  categoryId: string,
  input: SubcategoryCreateInput
) {
  const category = await db.query.categories.findFirst({
    where: and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)),
  });

  if (!category) {
    throw AppError.notFound('Category not found');
  }

  // Name uniqueness check within category for active subcategories
  const existingActive = await db.query.subcategories.findFirst({
    where: and(
      eq(subcategories.categoryId, categoryId),
      isNull(subcategories.archivedAt),
      sql`lower(${subcategories.name}) = ${input.name.toLowerCase()}`
    ),
  });

  if (existingActive) {
    throw AppError.conflict(
      'A subcategory with this name already exists in this category',
      'NAME_TAKEN'
    );
  }

  // Anti double-counting check: if this is the FIRST subcategory on this category
  const existingSubcats = await db.query.subcategories.findMany({
    where: eq(subcategories.categoryId, categoryId),
  });

  const isFirstSubcategory = existingSubcats.length === 0;
  if (isFirstSubcategory) {
    // Check if category already has lines with expectedAmount or transactions
    const existingLines = await db
      .select({
        id: budgetLines.id,
        expectedAmount: budgetLines.expectedAmount,
      })
      .from(budgetLines)
      .where(and(eq(budgetLines.categoryId, categoryId), isNull(budgetLines.subcategoryId)));

    for (const line of existingLines) {
      if (line.expectedAmount !== null) {
        throw AppError.conflict(
          'Cannot add subcategories to a category that has budget amounts or transactions. Move or delete them first.',
          'CATEGORY_HAS_DATA'
        );
      }

      const [txCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(transactions)
        .where(eq(transactions.budgetLineId, line.id));

      if (txCount && txCount.count > 0) {
        throw AppError.conflict(
          'Cannot add subcategories to a category that has budget amounts or transactions. Move or delete them first.',
          'CATEGORY_HAS_DATA'
        );
      }
    }
  }

  // If addToMonth specified, ensure month exists
  let targetMonthId: string | null = null;
  if (input.addToMonth) {
    const targetMonth = await db.query.months.findFirst({
      where: and(
        eq(months.workspaceId, workspaceId),
        eq(months.year, input.addToMonth.year),
        eq(months.month, input.addToMonth.month)
      ),
    });

    if (!targetMonth) {
      throw AppError.notFound('Target month does not exist');
    }
    targetMonthId = targetMonth.id;
  }

  return await db.transaction(async (tx) => {
    // If first subcategory, clean up any empty category-level lines
    if (isFirstSubcategory) {
      await tx
        .delete(budgetLines)
        .where(and(eq(budgetLines.categoryId, categoryId), isNull(budgetLines.subcategoryId)));
    }

    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [last] = await tx
        .select({ sortOrder: subcategories.sortOrder })
        .from(subcategories)
        .where(eq(subcategories.categoryId, categoryId))
        .orderBy(desc(subcategories.sortOrder))
        .limit(1);
      sortOrder = last ? last.sortOrder + 1 : 0;
    }

    const [newSubcategory] = await tx
      .insert(subcategories)
      .values({
        workspaceId,
        categoryId,
        name: input.name,
        sortOrder,
      })
      .returning();

    if (targetMonthId) {
      await tx.insert(budgetLines).values({
        workspaceId,
        monthId: targetMonthId,
        categoryId,
        subcategoryId: newSubcategory.id,
        expectedAmount: null,
      });
    }

    return {
      id: newSubcategory.id,
      categoryId: newSubcategory.categoryId,
      name: newSubcategory.name,
      sortOrder: newSubcategory.sortOrder,
      archivedAt: newSubcategory.archivedAt,
    };
  });
}

export async function updateSubcategory(
  workspaceId: string,
  subcategoryId: string,
  input: CategoryUpdateInput
) {
  const subcategory = await db.query.subcategories.findFirst({
    where: and(eq(subcategories.id, subcategoryId), eq(subcategories.workspaceId, workspaceId)),
  });

  if (!subcategory) {
    throw AppError.notFound('Subcategory not found');
  }

  const targetName = input.name ?? subcategory.name;
  const isTargetArchived =
    input.archived !== undefined ? input.archived : subcategory.archivedAt !== null;

  if (!isTargetArchived) {
    const nameConflict = await db.query.subcategories.findFirst({
      where: and(
        eq(subcategories.categoryId, subcategory.categoryId),
        isNull(subcategories.archivedAt),
        not(eq(subcategories.id, subcategory.id)),
        sql`lower(${subcategories.name}) = ${targetName.toLowerCase()}`
      ),
    });

    if (nameConflict) {
      throw AppError.conflict(
        'A subcategory with this name already exists in this category',
        'NAME_TAKEN'
      );
    }
  }

  let archivedAt = subcategory.archivedAt;
  if (input.archived === true && subcategory.archivedAt === null) {
    archivedAt = new Date();
  } else if (input.archived === false && subcategory.archivedAt !== null) {
    archivedAt = null;
  }

  const [updated] = await db
    .update(subcategories)
    .set({
      name: targetName,
      sortOrder: input.sortOrder !== undefined ? input.sortOrder : subcategory.sortOrder,
      archivedAt,
    })
    .where(and(eq(subcategories.id, subcategoryId), eq(subcategories.workspaceId, workspaceId)))
    .returning();

  return {
    id: updated.id,
    categoryId: updated.categoryId,
    name: updated.name,
    sortOrder: updated.sortOrder,
    archivedAt: updated.archivedAt,
  };
}
