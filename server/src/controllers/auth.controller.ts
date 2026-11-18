import { Request, Response } from 'express';
import { z } from 'zod';
import {
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
  generateSessionToken,
} from '../services/auth.service.js';

const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'Google ID token is required'),
});

/**
 * Handles Google OAuth login and registration via Google ID token.
 * POST /api/auth/google
 */
export async function googleLoginHandler(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = googleAuthSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.flatten(),
      });
      return;
    }

    const { idToken } = parseResult.data;

    // 1. Verify token with Google's public key infrastructure
    const verifiedProfile = await verifyGoogleIdToken(idToken);

    // 2. Find or create user in PostgreSQL
    const user = await findOrCreateGoogleUser(verifiedProfile);

    // 3. Issue application session JWT
    const token = generateSessionToken(user);

    res.json({
      success: true,
      message: 'Authentication successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        googleId: user.googleId,
      },
    });
  } catch (err: any) {
    console.error('❌ [Auth] Google authentication failed:', err.message);
    res.status(401).json({
      error: 'Authentication failed',
      message: err.message || 'Invalid or expired Google token',
    });
  }
}

/**
 * Returns current authenticated user profile.
 * GET /api/auth/me
 */
export async function getCurrentUserHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized', message: 'Not authenticated' });
    return;
  }

  res.json({
    success: true,
    user: req.user,
  });
}

/**
 * Handles user logout.
 * POST /api/auth/logout
 */
export async function logoutHandler(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
}
