import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma.js';
import { verifySessionToken } from '../services/auth.service.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  googleId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Express middleware to authenticate API requests using Bearer JWT session token.
 * Populates req.user with the verified database User record.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Missing or malformed Bearer token.',
    });
    return;
  }

  const token = authHeader.split(' ')[1]?.trim();
  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication token is empty.',
    });
    return;
  }

  try {
    const payload = verifySessionToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        googleId: true,
      },
    });

    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'The user account associated with this session no longer exists.',
      });
      return;
    }

    req.user = user;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Your session has expired. Please log in again.',
        code: 'TOKEN_EXPIRED',
      });
      return;
    }

    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid session token.',
      code: 'INVALID_TOKEN',
    });
  }
}
