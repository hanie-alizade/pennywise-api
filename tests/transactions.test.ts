import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { setupTestDb, resetTestDb } from './testDb.js';

describe('Transactions & Month View Integration Tests', () => {
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

  describe('Calendar Date Validation', () => {
    it('rejects invalid dates like 2026-02-30 or 2026-13-01 with 400 VALIDATION_ERROR', async () => {
      // Create category & month
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Groceries', type: 'expense' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 2 });

      const lineId = month.body.expense.categories[0].lineId;

      // 2026-02-30 is invalid calendar date (2026 is non-leap year, Feb has 28 days)
      const res1 = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 5000, date: '2026-02-30' });

      expect(res1.status).toBe(400);
      expect(res1.body.error.code).toBe('VALIDATION_ERROR');

      // 2026-02-29 is also invalid in 2026
      const res2 = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 5000, date: '2026-02-29' });

      expect(res2.status).toBe(400);
      expect(res2.body.error.code).toBe('VALIDATION_ERROR');

      // 2026-04-31 is invalid (April has 30 days)
      const res3 = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 5000, date: '2026-04-31' });

      expect(res3.status).toBe(400);
      expect(res3.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-positive amounts with 400 VALIDATION_ERROR', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Salary', type: 'income' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = month.body.income.categories[0].lineId;

      const resZero = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 0, date: '2026-10-15' });

      expect(resZero.status).toBe(400);
      expect(resZero.body.error.code).toBe('VALIDATION_ERROR');

      const resNeg = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: -500, date: '2026-10-15' });

      expect(resNeg.status).toBe(400);
      expect(resNeg.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Transaction Date-Outside-Month Rule', () => {
    it('rejects transaction date outside the line month with 422 TRANSACTION_DATE_OUTSIDE_MONTH', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Dining', type: 'expense' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = month.body.expense.categories[0].lineId;

      // Purchase from 2026-09-28 into 2026-10 line must be rejected!
      const res = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 3500, date: '2026-09-28' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TRANSACTION_DATE_OUTSIDE_MONTH');
    });

    it('rejects PATCH date modification that moves date outside line month', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Dining', type: 'expense' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = month.body.expense.categories[0].lineId;

      const tx = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 3500, date: '2026-10-05' });

      expect(tx.status).toBe(201);

      // Try updating date to November
      const patchRes = await request(app)
        .patch(`/transactions/${tx.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ date: '2026-11-01' });

      expect(patchRes.status).toBe(422);
      expect(patchRes.body.error.code).toBe('TRANSACTION_DATE_OUTSIDE_MONTH');
    });
  });

  describe('CRUD on Transactions and Running Totals', () => {
    it('creates, lists (newest date first), edits, and deletes transactions', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Groceries', type: 'expense' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = month.body.expense.categories[0].lineId;

      // Create Tx 1: Oct 5, amount 2500
      const tx1 = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 2500, date: '2026-10-05' });
      expect(tx1.status).toBe(201);
      expect(tx1.body.amount).toBe(2500);
      expect(tx1.body.date).toBe('2026-10-05');
      expect(tx1.body.createdBy).toBeDefined();

      // Create Tx 2: Oct 20, amount 7500
      const tx2 = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 7500, date: '2026-10-20' });
      expect(tx2.status).toBe(201);

      // List transactions: total should be 10000, newest date first (tx2 then tx1)
      const listRes = await request(app)
        .get(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.total).toBe(10000);
      expect(listRes.body.transactions).toHaveLength(2);
      expect(listRes.body.transactions[0].id).toBe(tx2.body.id);
      expect(listRes.body.transactions[1].id).toBe(tx1.body.id);

      // Edit Tx 1: amount -> 3000, date -> 2026-10-06
      const patchRes = await request(app)
        .patch(`/transactions/${tx1.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 3000, date: '2026-10-06' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.amount).toBe(3000);
      expect(patchRes.body.date).toBe('2026-10-06');

      // Verify list total updated to 10500
      const listRes2 = await request(app)
        .get(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`);
      expect(listRes2.body.total).toBe(10500);

      // Delete Tx 2
      const deleteRes = await request(app)
        .delete(`/transactions/${tx2.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`);
      expect(deleteRes.status).toBe(204);

      // Verify list total is now 3000 with 1 transaction
      const listRes3 = await request(app)
        .get(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`);
      expect(listRes3.body.total).toBe(3000);
      expect(listRes3.body.transactions).toHaveLength(1);
    });

    it('reverts line actual to null when last transaction is deleted', async () => {
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Books', type: 'expense' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = month.body.expense.categories[0].lineId;

      // Add a transaction
      const tx = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 1500, date: '2026-10-10' });

      // Check month view: actual is 1500
      const view1 = await request(app)
        .get('/months/2026/10')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(view1.body.expense.categories[0].actual).toBe(1500);

      // Delete the transaction
      await request(app)
        .delete(`/transactions/${tx.body.id}`)
        .set('Authorization', `Bearer ${userAToken}`);

      // Check month view: actual is now null (unset, not 0!)
      const view2 = await request(app)
        .get('/months/2026/10')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(view2.body.expense.categories[0].actual).toBeNull();
      expect(view2.body.expense.categories[0].transactionCount).toBe(0);
      expect(view2.body.expense.totals.hasAnyActual).toBe(false);
    });
  });

  describe('Month View Calculations, Parent Anti Double-Counting & Sign Conventions', () => {
    it('correctly calculates parent totals, section totals, and sign conventions', async () => {
      // 1. Income category: Salary (expected 8000.00 MYR = 800000 sen)
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Salary', type: 'income' });

      // 2. Expense Parent: Housing with subcategories Rent and Utilities
      const housing = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Housing', type: 'expense' });

      await request(app)
        .post(`/categories/${housing.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Rent' });

      await request(app)
        .post(`/categories/${housing.body.id}/subcategories`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Utilities' });

      // 3. Expense Leaf: Groceries (no subcategories)
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Groceries', type: 'expense' });

      // Create month 2026-10
      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      // Find line IDs
      const salaryLineId = month.body.income.categories[0].lineId;
      const housingCat = month.body.expense.categories.find(
        (c: { name: string }) => c.name === 'Housing'
      );
      const rentLineId = housingCat.children.find(
        (c: { name: string }) => c.name === 'Rent'
      ).lineId;
      const utilitiesLineId = housingCat.children.find(
        (c: { name: string }) => c.name === 'Utilities'
      ).lineId;
      const groceriesLineId = month.body.expense.categories.find(
        (c: { name: string }) => c.name === 'Groceries'
      ).lineId;

      // Set expected amounts:
      // Salary: 800000
      await request(app)
        .patch(`/budget-lines/${salaryLineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 800000 });

      // Rent: 250000
      await request(app)
        .patch(`/budget-lines/${rentLineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 250000 });

      // Utilities: 30000
      await request(app)
        .patch(`/budget-lines/${utilitiesLineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 30000 });

      // Groceries: 120000
      await request(app)
        .patch(`/budget-lines/${groceriesLineId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expected: 120000 });

      // Add transactions:
      // Salary actual: 850000 (earned more: 8500.00 MYR)
      await request(app)
        .post(`/budget-lines/${salaryLineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 850000, date: '2026-10-25' });

      // Rent actual: 250000 (spent exactly budget)
      await request(app)
        .post(`/budget-lines/${rentLineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 250000, date: '2026-10-01' });

      // Utilities: NO transactions -> actual is null
      // Groceries: 140000 (overspent: 1400.00 MYR)
      await request(app)
        .post(`/budget-lines/${groceriesLineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 140000, date: '2026-10-12' });

      // Fetch GET /months/2026/10
      const viewRes = await request(app)
        .get('/months/2026/10')
        .set('Authorization', `Bearer ${userAToken}`);

      expect(viewRes.status).toBe(200);
      const v = viewRes.body;

      // 1. Income Section Verification
      // Income difference = actual - expected = 850000 - 800000 = +50000 (earned more)
      expect(v.income.totals.expected).toBe(800000);
      expect(v.income.totals.actual).toBe(850000);
      expect(v.income.totals.difference).toBe(50000);
      expect(v.income.totals.hasAnyActual).toBe(true);

      // 2. Housing Parent Verification (Anti double-counting!)
      // Expected = Rent (250000) + Utilities (30000) = 280000
      // Actual = Rent (250000) + Utilities (null treated as 0 in computed sum) = 250000
      const housingView = v.expense.categories.find((c: { name: string }) => c.name === 'Housing');
      expect(housingView.hasSubcategories).toBe(true);
      expect(housingView.expectedIsComputed).toBe(true);
      expect(housingView.lineId).toBeNull();
      expect(housingView.expected).toBe(280000);
      expect(housingView.actual).toBe(250000);

      // Utilities line has null actual
      const utilLine = housingView.children.find((c: { name: string }) => c.name === 'Utilities');
      expect(utilLine.actual).toBeNull();

      // 3. Expense Section Totals (Only leaf lines summed! Housing itself is NOT double-counted!)
      // Leaf lines: Rent (exp: 250000, act: 250000), Utilities (exp: 30000, act: null), Groceries (exp: 120000, act: 140000)
      // Expected = 250000 + 30000 + 120000 = 400000
      // Actual = 250000 + 0 + 140000 = 390000
      // Expense difference = expected - actual = 400000 - 390000 = +10000 (under budget)
      expect(v.expense.totals.expected).toBe(400000);
      expect(v.expense.totals.actual).toBe(390000);
      expect(v.expense.totals.difference).toBe(10000);
      expect(v.expense.totals.hasAnyActual).toBe(true);

      // 4. Net Calculations:
      // net.expected = income.expected - expense.expected = 800000 - 400000 = 400000
      // net.actual = income.actual - expense.actual = 850000 - 390000 = 460000
      expect(v.net.expected).toBe(400000);
      expect(v.net.actual).toBe(460000);
    });
  });

  describe('Cross-Workspace Tenant Isolation', () => {
    it('returns 404 NOT_FOUND when User B attempts to access User A transactions', async () => {
      // User A creates month and transaction
      await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ name: 'Private', type: 'expense' });

      const month = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ year: 2026, month: 10 });

      const lineId = month.body.expense.categories[0].lineId;

      const txA = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ amount: 9900, date: '2026-10-10' });

      expect(txA.status).toBe(201);

      // User B attempts to list transactions of User A's line
      const listRes = await request(app)
        .get(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(listRes.status).toBe(404);
      expect(listRes.body.error.code).toBe('NOT_FOUND');

      // User B attempts to add transaction to User A's line
      const postRes = await request(app)
        .post(`/budget-lines/${lineId}/transactions`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ amount: 5000, date: '2026-10-10' });

      expect(postRes.status).toBe(404);
      expect(postRes.body.error.code).toBe('NOT_FOUND');

      // User B attempts to patch User A's transaction
      const patchRes = await request(app)
        .patch(`/transactions/${txA.body.id}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ amount: 1000 });

      expect(patchRes.status).toBe(404);
      expect(patchRes.body.error.code).toBe('NOT_FOUND');

      // User B attempts to delete User A's transaction
      const deleteRes = await request(app)
        .delete(`/transactions/${txA.body.id}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(deleteRes.status).toBe(404);
      expect(deleteRes.body.error.code).toBe('NOT_FOUND');
    });
  });
});
