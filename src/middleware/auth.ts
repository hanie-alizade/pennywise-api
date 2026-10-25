import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { resolveWorkspace } from '../modules/auth/service.js';

interface JwtPayload {
  sub: string;
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or invalid authorization header');
  }

  const token = authHeader.substring(7);

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Token expired');
    }
    throw AppError.unauthorized('Invalid token');
  }

  if (!payload.sub) {
    throw AppError.unauthorized('Invalid token payload');
  }

  // Resolve verified user and workspace
  const { user, workspace } = await resolveWorkspace(payload.sub);

  req.user = user;
  req.workspace = workspace;

  next();
}
