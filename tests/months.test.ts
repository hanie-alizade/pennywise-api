import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { setupTestDb, resetTestDb } from './testDb.js';
import { db } from '../src/db/client.js';
import { transactions } from '../src/db/schema.js';

describe('Months & Budget Lines Integration Tests', () => {
  let userAToken: string;
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

    // Register User B
    const regB = await request(app).post('/auth/register').send({
      email: 'userB@example.com',
      password: 'Password123!',
    });
    userBToken = regB.body.accessToken;
  });

  describe('POST /months & GET /months', () => {
    it('creates an empty month with lines for all active leaves', async () => {
      // Create active leaf category (Salary - income)
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Salary', type: 'income' });

      // Create parent category with subcategories (Housing -> Rent)
      const housing = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      await request(app)
        .post(`/categories/${housing.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      // Create month 2026-10
      const createRes = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      expect(createRes.status).toBe(201);
      expect(createRes.body.year).toBe(2026);
      expect(createRes.body.month).toBe(10);
      expect(createRes.body.currency).toBe('MYR');

      // Verify income has Salary with null expected
      expect(createRes.body.income.categories).toHaveLength(1);
      expect(createRes.body.income.categories[0].name).toBe('Salary');
      expect(createRes.body.income.categories[0].expected).toBeNull();
      expect(createRes.body.income.categories[0].hasSubcategories).toBe(false);

      // Verify expense has Housing as parent with Rent child
      expect(createRes.body.expense.categories).toHaveLength(1);
      expect(createRes.body.expense.categories[0].name).toBe('Housing');
      expect(createRes.body.expense.categories[0].hasSubcategories).toBe(true);
      expect(createRes.body.expense.categories[0].lineId).toBeNull();
      expect(createRes.body.expense.categories[0].children).toHaveLength(1);
      expect(createRes.body.expense.categories[0].children[0].name).toBe('Rent');
      expect(createRes.body.expense.categories[0].children[0].expected).toBeNull();

      // List months (newest first)
      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 11 });

      const listRes = await request(app)
        .get('/months')
        .set('Authorization', `Bearer ${userAToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.months).toHaveLength(2);
      expect(listRes.body.months[0].month).toBe(11);
      expect(listRes.body.months[1].month).toBe(10);
    });

    it('rejects duplicate month creation with 409 MONTH_EXISTS', async () => {
      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const res = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MONTH_EXISTS');
    });

    it('rejects copyFrom when source month does not exist with 404', async () => {
      const res = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          year: 2026,
          month: 11,
          copyFrom: { year: 2026, month: 10 },
        });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Source month');
    });
  });

  describe('Month Copy (Section 4.3 Business Rules)', () => {
    it('copies Expected amounts, drops transactions, skips archived, and leaves source untouched', async () => {
      // 1. Setup categories
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Salary', type: 'income' });

      const housing = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      await request(app)
        .post(`/categories/${housing.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      const utilities = await request(app)
        .post(`/categories/${housing.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Utilities' });

      // 2. Create source month 2026-10
      const octMonth = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      // Set expected on Salary line
      const salaryLineId = octMonth.body.income.categories[0].lineId;
      await request(app)
        .patch(`/budget-lines/${salaryLineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 800000 }); // 8000.00 MYR

      // Set expected on Rent line
      const rentLineId = octMonth.body.expense.categories[0].children[0].lineId;
      await request(app)
        .patch(`/budget-lines/${rentLineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 250000 }); // 2500.00 MYR

      // Insert transaction directly on Rent line in Oct
      const [userARow] = await db.query.users.findMany({ limit: 1 });
      const [workspaceARow] = await db.query.workspaces.findMany({ limit: 1 });
      await db.insert(transactions).values({
        workspaceId: workspaceARow.id,
        budgetLineId: rentLineId,
        amount: 250000,
        transactionDate: '2026-10-01',
        createdBy: userARow.id,
      });

      // Archive Utilities subcategory before copy
      await request(app)
        .patch(`/subcategories/${utilities.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ archived: true });

      // 3. Create target month 2026-11 with copyFrom 2026-10
      const novMonth = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          year: 2026,
          month: 11,
          copyFrom: { year: 2026, month: 10 },
        });

      expect(novMonth.status).toBe(201);

      // Verify Salary expected was copied (800000)
      const novSalary = novMonth.body.income.categories[0];
      expect(novSalary.expected).toBe(800000);
      expect(novSalary.actual).toBeNull(); // Actual is NOT copied!

      // Verify Housing parent
      const novHousing = novMonth.body.expense.categories[0];
      // Expected = sum of children (Rent: 250000)
      expect(novHousing.expected).toBe(250000);
      // Actual = null (never copied transactions!)
      expect(novHousing.actual).toBeNull();
      expect(novHousing.transactionCount).toBe(0);

      // Verify archived Utilities was NOT added to Nov month
      expect(novHousing.children).toHaveLength(1);
      expect(novHousing.children[0].name).toBe('Rent');
      expect(novHousing.children[0].expected).toBe(250000);
      expect(novHousing.children[0].actual).toBeNull();
      expect(novHousing.children[0].transactionCount).toBe(0);

      // 4. Verify source month (2026-10) was left untouched!
      const octCheck = await request(app)
        .get('/months/2026/10')
        .set('Authorization', `Bearer ${userAToken}`);

      expect(octCheck.status).toBe(200);
      const octRentLine = octCheck.body.expense.categories[0].children.find(
        (c: { name: string }) => c.name === 'Rent'
      );
      expect(octRentLine.actual).toBe(250000);
      expect(octRentLine.transactionCount).toBe(1);
      // Utilities is still present in Oct because it had a line there
      expect(octCheck.body.expense.categories[0].children).toHaveLength(2);
    });
  });

  describe('POST /months/:year/:month/lines', () => {
    it('adds a leaf line to an existing month', async () => {
      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      // Create a category after month creation
      const transport = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Transportation', type: 'expense' });

      // Add line to Oct
      const addLineRes = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          categoryId: transport.body.id,
          expected: 40000,
        });

      expect(addLineRes.status).toBe(201);
      const transCat = addLineRes.body.expense.categories.find(
        (c: { name: string }) => c.name === 'Transportation'
      );
      expect(transCat).toBeDefined();
      expect(transCat.expected).toBe(40000);
      expect(transCat.hasSubcategories).toBe(false);
    });

    it('rejects adding category-level line to a category with subcategories (422)', async () => {
      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const housing = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      await request(app)
        .post(`/categories/${housing.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      // Try adding category-level line
      const res = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ categoryId: housing.body.id });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CATEGORY_HAS_SUBCATEGORIES');
    });

    it('rejects adding duplicate line with 409 LINE_EXISTS', async () => {
      const cat = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Food', type: 'expense' });

      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      // Already has a line from month creation
      const res = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ categoryId: cat.body.id });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LINE_EXISTS');
    });
  });

  describe('PATCH & DELETE /budget-lines/:id', () => {
    it('updates expected amount of a line and returns LineRow', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Shopping', type: 'expense' });

      const monthRes = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = monthRes.body.expense.categories[0].lineId;

      const patchRes = await request(app)
        .patch(`/budget-lines/${lineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 15000 });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body).toEqual({
        lineId,
        subcategoryId: null,
        name: 'Shopping',
        archived: false,
        expected: 15000,
        actual: null,
        transactionCount: 0,
      });

      // Can clear expected amount to null
      const clearRes = await request(app)
        .patch(`/budget-lines/${lineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: null });

      expect(clearRes.status).toBe(200);
      expect(clearRes.body.expected).toBeNull();
    });

    it('deletes empty line (204) and blocks deletion if line has transactions (409)', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Misc', type: 'expense' });

      const monthRes = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = monthRes.body.expense.categories[0].lineId;

      // Add a transaction on lineId
      const [userARow] = await db.query.users.findMany({ limit: 1 });
      const [workspaceARow] = await db.query.workspaces.findMany({ limit: 1 });
      await db.insert(transactions).values({
        workspaceId: workspaceARow.id,
        budgetLineId: lineId,
        amount: 2500,
        transactionDate: '2026-10-15',
        createdBy: userARow.id,
      });

      // Try deleting line with transaction -> 409 LINE_HAS_TRANSACTIONS
      const deleteFail = await request(app)
        .delete(`/budget-lines/${lineId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      expect(deleteFail.status).toBe(409);
      expect(deleteFail.body.error.code).toBe('LINE_HAS_TRANSACTIONS');

      // Add another empty line
      const cat2 = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'EmptyLine', type: 'expense' });

      const addLine = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ categoryId: cat2.body.id });

      const emptyLineId = addLine.body.expense.categories.find(
        (c: { name: string }) => c.name === 'EmptyLine'
      ).lineId;

      const deleteOk = await request(app)
        .delete(`/budget-lines/${emptyLineId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      expect(deleteOk.status).toBe(204);
    });
  });

  describe('Cross-Workspace Tenant Isolation', () => {
    it('returns 404 when User B attempts to view, modify, or delete User A months or lines', async () => {
      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      // User B attempts to GET User A's month (User B has not created 2026-10)
      const getMonthRes = await request(app)
        .get('/months/2026/10')
        .set('Authorization', `Bearer ${userBToken}`);

      expect(getMonthRes.status).toBe(404);

      // User A creates category and line
      const catA = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Private Cat', type: 'expense' });

      const addLine = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ categoryId: catA.body.id, expected: 5000 });

      const lineIdA = addLine.body.expense.categories.find(
        (c: { name: string }) => c.name === 'Private Cat'
      ).lineId;

      // User B attempts to patch User A's line
      const patchRes = await request(app)
        .patch(`/budget-lines/${lineIdA}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ expected: 99999 });

      expect(patchRes.status).toBe(404);
      expect(patchRes.body.error.code).toBe('NOT_FOUND');

      // User B attempts to delete User A's line
      const deleteRes = await request(app)
        .delete(`/budget-lines/${lineIdA}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(deleteRes.status).toBe(404);
      expect(deleteRes.body.error.code).toBe('NOT_FOUND');
    });
  });
});
