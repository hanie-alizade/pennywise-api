import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, workspaces, memberships, refreshTokens } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { CredentialsInput } from './schemas.js';

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateAccessToken(userId: string): { accessToken: string; expiresIn: number } {
  const expiresIn = env.JWT_ACCESS_EXPIRES_IN;
  const accessToken = jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, {
    expiresIn,
  });
  return { accessToken, expiresIn };
}

export function getRefreshTokenExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + env.REFRESH_TOKEN_EXPIRES_DAYS);
  return expiry;
}

export async function register(input: CredentialsInput) {
  // 1. Check for existing user
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });

  if (existingUser) {
    throw AppError.conflict('Email is already registered', 'EMAIL_TAKEN');
  }

  // 2. Hash password
  const passwordHash = await bcrypt.hash(input.password, 10);

  // 3. Atomically create user, workspace, membership, and refresh token
  return await db.transaction(async (tx) => {
    const [newUser] = await tx
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
      })
      .returning({ id: users.id, email: users.email });

    const [newWorkspace] = await tx
      .insert(workspaces)
      .values({
        name: 'Personal',
        currency: 'MYR',
      })
      .returning({ id: workspaces.id });

    await tx.insert(memberships).values({
      workspaceId: newWorkspace.id,
      userId: newUser.id,
      role: 'owner',
    });

    const { accessToken, expiresIn } = generateAccessToken(newUser.id);
    const rawRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(rawRefreshToken);

    await tx.insert(refreshTokens).values({
      userId: newUser.id,
      tokenHash,
      expiresAt: getRefreshTokenExpiry(),
      deviceLabel: null,
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn,
      user: {
        id: newUser.id,
        email: newUser.email,
      },
    };
  });
}

export async function login(input: CredentialsInput) {
  const user = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });

  if (!user) {
    throw AppError.unauthorized('Invalid email or password');
  }

  const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!isPasswordValid) {
    throw AppError.unauthorized('Invalid email or password');
  }

  const { accessToken, expiresIn } = generateAccessToken(user.id);
  const rawRefreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawRefreshToken);

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt: getRefreshTokenExpiry(),
    deviceLabel: null,
  });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn,
    user: {
      id: user.id,
      email: user.email,
    },
  };
}

export async function refresh(rawRefreshToken: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  const existingToken = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, tokenHash),
  });

  if (!existingToken) {
    throw AppError.unauthorized('Invalid refresh token');
  }

  // Reuse Detection: if this token was already revoked, revoke ALL tokens for this user
  if (existingToken.revokedAt !== null) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, existingToken.userId), isNull(refreshTokens.revokedAt)));

    throw AppError.unauthorized('Invalid or revoked refresh token');
  }

  // Expiry check
  if (new Date(existingToken.expiresAt) < new Date()) {
    throw AppError.unauthorized('Refresh token expired');
  }

  // Atomically rotate refresh token
  return await db.transaction(async (tx) => {
    const now = new Date();

    // Revoke old token
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now, lastUsedAt: now })
      .where(eq(refreshTokens.id, existingToken.id));

    // Create new refresh token
    const newRawRefreshToken = generateRefreshToken();
    const newTokenHash = hashRefreshToken(newRawRefreshToken);

    await tx.insert(refreshTokens).values({
      userId: existingToken.userId,
      tokenHash: newTokenHash,
      expiresAt: getRefreshTokenExpiry(),
      deviceLabel: existingToken.deviceLabel,
    });

    const { accessToken, expiresIn } = generateAccessToken(existingToken.userId);

    return {
      accessToken,
      refreshToken: newRawRefreshToken,
      expiresIn,
    };
  });
}

export async function logout(rawRefreshToken: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}

export async function resolveWorkspace(userId: string) {
  const result = await db
    .select({
      user: {
        id: users.id,
        email: users.email,
      },
      workspace: {
        id: workspaces.id,
        name: workspaces.name,
        currency: workspaces.currency,
        role: memberships.role,
      },
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId))
    .limit(1);

  if (result.length === 0) {
    throw AppError.unauthorized('User has no active workspace');
  }

  const row = result[0];
  return {
    user: row.user,
    workspace: {
      id: row.workspace.id,
      name: row.workspace.name,
      currency: row.workspace.currency,
      role: row.workspace.role as 'owner' | 'member',
    },
  };
}
