import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { setupTestDb, resetTestDb } from './testDb.js';
import { env } from '../src/config/env.js';

describe('Auth Module Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  describe('POST /auth/register', () => {
    it('successfully registers user and creates personal workspace', async () => {
      const res = await request(app).post('/auth/register').send({
        email: 'test@example.com',
        password: 'ValidPassword123!',
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.user).toEqual({
        id: expect.any(String),
        email: 'test@example.com',
      });

      // Verify user can immediately access /me with returned accessToken
      const meRes = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user.email).toBe('test@example.com');
      expect(meRes.body.workspace).toEqual({
        id: expect.any(String),
        name: 'Personal',
        currency: 'MYR',
        role: 'owner',
      });
    });

    it('rejects duplicate email with 409 EMAIL_TAKEN', async () => {
      await request(app).post('/auth/register').send({
        email: 'duplicate@example.com',
        password: 'Password123!',
      });

      const res = await request(app).post('/auth/register').send({
        email: 'duplicate@example.com',
        password: 'Password123!',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
      expect(res.body.error.message).toBe('Email is already registered');
    });

    it('rejects password shorter than 10 characters with 400 VALIDATION_ERROR', async () => {
      const res = await request(app).post('/auth/register').send({
        email: 'short@example.com',
        password: 'short',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    it('rejects password exceeding 72 bytes with 400 VALIDATION_ERROR', async () => {
      const longPassword = 'a'.repeat(73);
      const res = await request(app).post('/auth/register').send({
        email: 'toolong@example.com',
        password: longPassword,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('normalizes email to lowercase and trimmed', async () => {
      const res = await request(app).post('/auth/register').send({
        email: '  MixedCase@Example.COM  ',
        password: 'Password123!',
      });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('mixedcase@example.com');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await request(app).post('/auth/register').send({
        email: 'user@example.com',
        password: 'CorrectPassword123!',
      });
    });

    it('successfully logs in with valid credentials', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'user@example.com',
        password: 'CorrectPassword123!',
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body.user.email).toBe('user@example.com');
    });

    it('returns generic 401 UNAUTHORIZED on incorrect password', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'user@example.com',
        password: 'WrongPassword999!',
      });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    it('returns generic 401 UNAUTHORIZED on non-existent email', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'doesnotexist@example.com',
        password: 'Password123!',
      });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Invalid email or password');
    });
  });

  describe('POST /auth/refresh & Token Rotation', () => {
    it('successfully rotates refresh token and provides new access token', async () => {
      const reg = await request(app).post('/auth/register').send({
        email: 'rotate@example.com',
        password: 'Password123!',
      });

      const initialRefreshToken = reg.body.refreshToken;

      const refreshRes = await request(app).post('/auth/refresh').send({
        refreshToken: initialRefreshToken,
      });

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body).toHaveProperty('accessToken');
      expect(refreshRes.body).toHaveProperty('refreshToken');
      expect(refreshRes.body.refreshToken).not.toBe(initialRefreshToken);

      // Verify the new access token is valid
      const meRes = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${refreshRes.body.accessToken}`);
      expect(meRes.status).toBe(200);
    });

    it('detects refresh token reuse and revokes token family', async () => {
      const reg = await request(app).post('/auth/register').send({
        email: 'reuse@example.com',
        password: 'Password123!',
      });

      const initialRefreshToken = reg.body.refreshToken;

      // 1st refresh: rotates successfully
      const refresh1 = await request(app).post('/auth/refresh').send({
        refreshToken: initialRefreshToken,
      });
      expect(refresh1.status).toBe(200);
      const secondRefreshToken = refresh1.body.refreshToken;

      // Attacker or replay attempts to use initialRefreshToken again
      const reuseRes = await request(app).post('/auth/refresh').send({
        refreshToken: initialRefreshToken,
      });
      expect(reuseRes.status).toBe(401);
      expect(reuseRes.body.error.message).toContain('revoked');

      // Now the legitimate secondRefreshToken should also be revoked due to reuse detection
      const secondRefreshRes = await request(app).post('/auth/refresh').send({
        refreshToken: secondRefreshToken,
      });
      expect(secondRefreshRes.status).toBe(401);
    });

    it('rejects invalid or non-existent refresh token with 401', async () => {
      const res = await request(app).post('/auth/refresh').send({
        refreshToken: 'completely-invalid-refresh-token',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes refresh token on logout', async () => {
      const reg = await request(app).post('/auth/register').send({
        email: 'logout@example.com',
        password: 'Password123!',
      });

      const logoutRes = await request(app).post('/auth/logout').send({
        refreshToken: reg.body.refreshToken,
      });
      expect(logoutRes.status).toBe(204);

      // Subsequent refresh attempt with logged-out token must fail
      const refreshRes = await request(app).post('/auth/refresh').send({
        refreshToken: reg.body.refreshToken,
      });
      expect(refreshRes.status).toBe(401);
    });
  });

  describe('GET /me and Authorization Middleware', () => {
    it('rejects requests without authorization header with 401', async () => {
      const res = await request(app).get('/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects requests with expired access token', async () => {
      // Create token that expired 1 hour ago
      const expiredToken = jwt.sign(
        { sub: '00000000-0000-0000-0000-000000000000' },
        env.JWT_ACCESS_SECRET,
        { expiresIn: -3600 }
      );

      const res = await request(app).get('/me').set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Token expired');
    });

    it('rejects requests with token signed by wrong secret', async () => {
      const fraudulentToken = jwt.sign(
        { sub: '00000000-0000-0000-0000-000000000000' },
        'wrong-secret-key-that-does-not-match'
      );

      const res = await request(app).get('/me').set('Authorization', `Bearer ${fraudulentToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid token');
    });
  });
});
