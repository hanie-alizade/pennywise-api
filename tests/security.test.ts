import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { setupTestDb, resetTestDb } from './testDb.js';

describe('Security & Workspace Isolation Matrix', () => {
  let userAToken: string;
  let userBToken: string;

  // Resource IDs belonging to User A
  let userACategoryId: string;
  let userASubcategoryId: string;
  let userAYear: number;
  let userAMonth: number;
  let userALineId: string;
  let userATransactionId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();

    // 1. Register User A
    const regA = await request(app).post('/auth/register').send({
      email: 'usera_sec@example.com',
      password: 'Password123!',
    });
    userAToken = regA.body.accessToken;

    // 2. Register User B
    const regB = await request(app).post('/auth/register').send({
      email: 'userb_sec@example.com',
      password: 'Password123!',
    });
    userBToken = regB.body.accessToken;

    // 3. User A creates full hierarchy of budget data
    userAYear = 2026;
    userAMonth = 10;

    // Create category
    const catRes = await request(app)
      .post('/categories')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ name: 'User A Secret Category', type: 'expense' });
    userACategoryId = catRes.body.id;

    // Create subcategory
    const subRes = await request(app)
      .post(`/categories/${userACategoryId}/subcategories`)
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ name: 'User A Secret Subcategory' });
    userASubcategoryId = subRes.body.id;

    // Create month
    const monthRes = await request(app)
      .post('/months')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ year: userAYear, month: userAMonth });

    const housing = monthRes.body.expense.categories.find(
      (c: { categoryId: string }) => c.categoryId === userACategoryId
    );
    userALineId = housing.children[0].lineId;

    // Create transaction on User A's leaf line
    const txRes = await request(app)
      .post(`/budget-lines/${userALineId}/transactions`)
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ amount: 99900, date: '2026-10-15' });
    userATransactionId = txRes.body.id;
  });

  describe('Category Endpoints Authorization Matrix', () => {
    it('GET /categories returns only the authenticated user categories', async () => {
      const resA = await request(app)
        .get('/categories')
        .set('Authorization', `Bearer ${userAToken}`);
      expect(resA.status).toBe(200);
      expect(resA.body.categories).toHaveLength(1);
      expect(resA.body.categories[0].id).toBe(userACategoryId);

      const resB = await request(app)
        .get('/categories')
        .set('Authorization', `Bearer ${userBToken}`);
      expect(resB.status).toBe(200);
      expect(resB.body.categories).toHaveLength(0);
    });

    it('PATCH /categories/:id returns 404 NOT_FOUND when User B targets User A category', async () => {
      const res = await request(app)
        .patch(`/categories/${userACategoryId}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Hacked Name' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('POST /categories/:id/subcategories returns 404 NOT_FOUND when User B targets User A category', async () => {
      const res = await request(app)
        .post(`/categories/${userACategoryId}/subcategories`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Hacked Sub' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('PATCH /subcategories/:id returns 404 NOT_FOUND when User B targets User A subcategory', async () => {
      const res = await request(app)
        .patch(`/subcategories/${userASubcategoryId}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Hacked Sub' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Month & Budget Line Endpoints Authorization Matrix', () => {
    it('GET /months returns only User B months', async () => {
      const resB = await request(app).get('/months').set('Authorization', `Bearer ${userBToken}`);
      expect(resB.status).toBe(200);
      expect(resB.body.months).toHaveLength(0);
    });

    it('GET /months/:year/:month returns 404 NOT_FOUND when User B requests User A month', async () => {
      const res = await request(app)
        .get(`/months/${userAYear}/${userAMonth}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('POST /months copyFrom returns 404 NOT_FOUND when User B attempts to copy User A month', async () => {
      // User B creates 2026-11 attempting to copy User A's 2026-10
      const res = await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({
          year: 2026,
          month: 11,
          copyFrom: { year: userAYear, month: userAMonth },
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('POST /months/:year/:month/lines returns 404 NOT_FOUND when User B targets User A month or category', async () => {
      // User B creates their own category
      const catB = await request(app)
        .post('/categories')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ name: 'Cat B', type: 'expense' });

      // User B attempts to add line into User A's month
      const res1 = await request(app)
        .post(`/months/${userAYear}/${userAMonth}/lines`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ categoryId: catB.body.id });

      expect(res1.status).toBe(404);
      expect(res1.body.error.code).toBe('NOT_FOUND');

      // User B creates their own month
      await request(app)
        .post('/months')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ year: 2026, month: 10 });

      // User B attempts to add User A's category into User B's month
      const res2 = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ categoryId: userACategoryId });

      expect(res2.status).toBe(404);
      expect(res2.body.error.code).toBe('NOT_FOUND');

      // User B attempts to add User A's subcategory into User B's month
      const res3 = await request(app)
        .post('/months/2026/10/lines')
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ subcategoryId: userASubcategoryId });

      expect(res3.status).toBe(404);
      expect(res3.body.error.code).toBe('NOT_FOUND');
    });

    it('PATCH /budget-lines/:id returns 404 NOT_FOUND when User B targets User A line', async () => {
      const res = await request(app)
        .patch(`/budget-lines/${userALineId}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ expected: 10000 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('DELETE /budget-lines/:id returns 404 NOT_FOUND when User B targets User A line', async () => {
      const res = await request(app)
        .delete(`/budget-lines/${userALineId}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Transaction Endpoints Authorization Matrix', () => {
    it('GET /budget-lines/:id/transactions returns 404 NOT_FOUND when User B targets User A line', async () => {
      const res = await request(app)
        .get(`/budget-lines/${userALineId}/transactions`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('POST /budget-lines/:id/transactions returns 404 NOT_FOUND when User B targets User A line', async () => {
      const res = await request(app)
        .post(`/budget-lines/${userALineId}/transactions`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ amount: 5000, date: '2026-10-15' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('PATCH /transactions/:id returns 404 NOT_FOUND when User B targets User A transaction', async () => {
      const res = await request(app)
        .patch(`/transactions/${userATransactionId}`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({ amount: 1000 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('DELETE /transactions/:id returns 404 NOT_FOUND when User B targets User A transaction', async () => {
      const res = await request(app)
        .delete(`/transactions/${userATransactionId}`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Unauthenticated and Invalid Token Access', () => {
    it('rejects unauthenticated requests to protected endpoints with 401 UNAUTHORIZED', async () => {
      const endpoints = [
        { method: 'get', url: '/me' },
        { method: 'get', url: '/categories' },
        { method: 'post', url: '/categories' },
        { method: 'patch', url: `/categories/${userACategoryId}` },
        { method: 'get', url: '/months' },
        { method: 'get', url: `/months/${userAYear}/${userAMonth}` },
        { method: 'post', url: '/months' },
        { method: 'patch', url: `/budget-lines/${userALineId}` },
        { method: 'delete', url: `/budget-lines/${userALineId}` },
        { method: 'get', url: `/budget-lines/${userALineId}/transactions` },
        { method: 'post', url: `/budget-lines/${userALineId}/transactions` },
        { method: 'patch', url: `/transactions/${userATransactionId}` },
        { method: 'delete', url: `/transactions/${userATransactionId}` },
      ];

      for (const ep of endpoints) {
        let reqBuilder;
        if (ep.method === 'get') reqBuilder = request(app).get(ep.url);
        else if (ep.method === 'post') reqBuilder = request(app).post(ep.url).send({});
        else if (ep.method === 'patch') reqBuilder = request(app).patch(ep.url).send({});
        else reqBuilder = request(app).delete(ep.url);

        const res = await reqBuilder;
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    });
  });
});
