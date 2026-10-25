import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { setupTestDb, resetTestDb } from './testDb.js';
import { db } from '../src/db/client.js';
import { months, budgetLines, transactions } from '../src/db/schema.js';

describe('Categories & Subcategories Integration Tests', () => {
  let userAToken: string;
  let userAWorkspaceId: string;
  let userBToken: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();

    // Register User A
    const regA = await request(app).post('/auth/register').send({
      email: 'userA@example.com',
      password: 'Password123!',
    });
    userAToken = regA.body.accessToken;

    const meA = await request(app).get('/me').set('Authorization', `Bearer ${userAToken}`);
    userAWorkspaceId = meA.body.workspace.id;

    // Register User B
    const regB = await request(app).post('/auth/register').send({
      email: 'userB@example.com',
      password: 'Password123!',
    });
    userBToken = regB.body.accessToken;
  });

  describe('POST & GET /categories', () => {
    it('creates and lists categories with their subcategories', async () => {
      const createRes = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          name: 'Food & Groceries',
          type: 'expense',
          sortOrder: 1,
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body).toEqual({
        id: expect.any(String),
        name: 'Food & Groceries',
        type: 'expense',
        sortOrder: 1,
        archivedAt: null,
        subcategories: [],
      });

      const listRes = await request(app)
        .get('/categories')
        .set('Authorization', `Bearer ${userAToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.categories).toHaveLength(1);
      expect(listRes.body.categories[0].name).toBe('Food & Groceries');
    });

    it('rejects duplicate active category names within the same type with 409 NAME_TAKEN', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      const res = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'housing', type: 'expense' }); // case-insensitive check

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_TAKEN');
    });

    it('allows same category name under different types (income vs expense)', async () => {
      const resExp = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Bonus', type: 'expense' });
      expect(resExp.status).toBe(201);

      const resInc = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Bonus', type: 'income' });
      expect(resInc.status).toBe(201);
    });

    it('returns 404 NOT_FOUND if addToMonth specifies non-existent month', async () => {
      const res = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          name: 'Utilities',
          type: 'expense',
          addToMonth: { year: 2026, month: 10 },
        });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('month does not exist');
    });

    it('creates line atomically when addToMonth specifies existing month', async () => {
      // Seed month for user A
      const [seededMonth] = await db
        .insert(months)
        .values({
          workspaceId: userAWorkspaceId,
          year: 2026,
          month: 10,
        })
        .returning();

      const res = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          name: 'Utilities',
          type: 'expense',
          addToMonth: { year: 2026, month: 10 },
        });

      expect(res.status).toBe(201);

      // Verify line created
      const lines = await db.query.budgetLines.findMany({
        where: (bl, { eq, and }) =>
          and(eq(bl.monthId, seededMonth.id), eq(bl.categoryId, res.body.id)),
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].subcategoryId).toBeNull();
      expect(lines[0].expectedAmount).toBeNull();
    });
  });

  describe('PATCH /categories/:id and Archive Behavior', () => {
    it('renames category and rejects conflict with existing active name', async () => {
      const cat1 = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Old Name', type: 'expense' });

      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Existing Name', type: 'expense' });

      // Renaming to conflict
      const conflictRes = await request(app)
        .patch(`/categories/${cat1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Existing Name' });

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.error.code).toBe('NAME_TAKEN');

      // Valid rename
      const okRes = await request(app)
        .patch(`/categories/${cat1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'New Name' });

      expect(okRes.status).toBe(200);
      expect(okRes.body.name).toBe('New Name');
    });

    it('allows reusing name of archived category, but blocks unarchiving into conflict', async () => {
      const cat1 = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Gym', type: 'expense' });

      // Archive Gym
      await request(app)
        .patch(`/categories/${cat1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ archived: true });

      // Creating a new active Gym is now allowed
      const cat2 = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Gym', type: 'expense' });
      expect(cat2.status).toBe(201);

      // Attempting to unarchive cat1 now must return 409 NAME_TAKEN
      const unarchiveConflict = await request(app)
        .patch(`/categories/${cat1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ archived: false });

      expect(unarchiveConflict.status).toBe(409);
      expect(unarchiveConflict.body.error.code).toBe('NAME_TAKEN');
    });

    it('filters out archived categories unless includeArchived=true', async () => {
      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Temporary', type: 'expense' });

      await request(app)
        .patch(`/categories/${cat.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ archived: true });

      const defaultList = await request(app)
        .get('/categories')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(defaultList.body.categories).toHaveLength(0);

      const fullList = await request(app)
        .get('/categories?includeArchived=true')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(fullList.body.categories).toHaveLength(1);
      expect(fullList.body.categories[0].archivedAt).not.toBeNull();
    });
  });

  describe('Subcategories & First-Subcategory Anti Double-Counting Rule', () => {
    it('allows creating first subcategory when category has no budget lines', async () => {
      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      const subRes = await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      expect(subRes.status).toBe(201);
      expect(subRes.body.name).toBe('Rent');
      expect(subRes.body.categoryId).toBe(cat.body.id);
    });

    it('allows creating first subcategory when category has empty budget lines (cleans them up)', async () => {
      const [seededMonth] = await db
        .insert(months)
        .values({
          workspaceId: userAWorkspaceId,
          year: 2026,
          month: 11,
        })
        .returning();

      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          name: 'Housing',
          type: 'expense',
          addToMonth: { year: 2026, month: 11 },
        });

      // The category has a line in 2026-11 with expectedAmount = null and 0 transactions
      const subRes = await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      expect(subRes.status).toBe(201);

      // Verify the empty category-level line was cleaned up
      const categoryLevelLines = await db.query.budgetLines.findMany({
        where: (bl, { eq, and, isNull }) =>
          and(
            eq(bl.monthId, seededMonth.id),
            eq(bl.categoryId, cat.body.id),
            isNull(bl.subcategoryId)
          ),
      });
      expect(categoryLevelLines).toHaveLength(0);
    });

    it('blocks creating first subcategory with 409 CATEGORY_HAS_DATA when line has expected_amount', async () => {
      const [seededMonth] = await db
        .insert(months)
        .values({
          workspaceId: userAWorkspaceId,
          year: 2026,
          month: 11,
        })
        .returning();

      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      // Insert budget line with expected amount
      await db.insert(budgetLines).values({
        workspaceId: userAWorkspaceId,
        monthId: seededMonth.id,
        categoryId: cat.body.id,
        subcategoryId: null,
        expectedAmount: 150000, // 1500.00 MYR
      });

      const subRes = await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      expect(subRes.status).toBe(409);
      expect(subRes.body.error.code).toBe('CATEGORY_HAS_DATA');
    });

    it('blocks creating first subcategory with 409 CATEGORY_HAS_DATA when line has transactions', async () => {
      const [seededMonth] = await db
        .insert(months)
        .values({
          workspaceId: userAWorkspaceId,
          year: 2026,
          month: 11,
        })
        .returning();

      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Groceries', type: 'expense' });

      const [line] = await db
        .insert(budgetLines)
        .values({
          workspaceId: userAWorkspaceId,
          monthId: seededMonth.id,
          categoryId: cat.body.id,
          subcategoryId: null,
          expectedAmount: null,
        })
        .returning();

      // Insert a transaction on the line
      await db.insert(transactions).values({
        workspaceId: userAWorkspaceId,
        budgetLineId: line.id,
        amount: 5500,
        transactionDate: '2026-11-05',
      });

      const subRes = await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Snacks' });

      expect(subRes.status).toBe(409);
      expect(subRes.body.error.code).toBe('CATEGORY_HAS_DATA');
    });

    it('enforces subcategory name uniqueness and unarchiving conflict checks', async () => {
      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Food', type: 'expense' });

      const sub1 = await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Dining' });

      const conflict = await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'dining' });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('NAME_TAKEN');

      // Archive Dining
      await request(app)
        .patch(`/subcategories/${sub1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ archived: true });

      // Create new Dining
      await request(app)
        .post(`/categories/${cat.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Dining' });

      // Unarchive original -> 409 NAME_TAKEN
      const unarchiveRes = await request(app)
        .patch(`/subcategories/${sub1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ archived: false });

      expect(unarchiveRes.status).toBe(409);
      expect(unarchiveRes.body.error.code).toBe('NAME_TAKEN');
    });
  });

  describe('Cross-Workspace Tenant Isolation', () => {
    it('returns 404 NOT_FOUND when User B attempts to access User A categories or subcategories', async () => {
      const catA = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Secret Cat', type: 'expense' });

      const subA = await request(app)
        .post(`/categories/${catA.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Secret Sub' });

      // User B attempts to patch User A's category
      const patchCatRes = await request(app)
        .patch(`/categories/${catA.body.id}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Hacked Cat' });

      expect(patchCatRes.status).toBe(404);
      expect(patchCatRes.body.error.code).toBe('NOT_FOUND');

      // User B attempts to add subcategory to User A's category
      const addSubRes = await request(app)
        .post(`/categories/${catA.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Hacked Sub' });

      expect(addSubRes.status).toBe(404);
      expect(addSubRes.body.error.code).toBe('NOT_FOUND');

      // User B attempts to patch User A's subcategory
      const patchSubRes = await request(app)
        .patch(`/subcategories/${subA.body.id}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Hacked Sub' });

      expect(patchSubRes.status).toBe(404);
      expect(patchSubRes.body.error.code).toBe('NOT_FOUND');

      // User B's list categories must be empty
      const listBRes = await request(app)
        .get('/categories')
        .set('Authorization', `Bearer ${userBToken}`);

      expect(listBRes.body.categories).toHaveLength(0);
    });
  });
});
