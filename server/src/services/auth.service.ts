import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/prisma.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWT_SECRET = process.env.JWT_SECRET || 'reachinbox_default_dev_jwt_secret_32bytes_random_dev_only!';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface GoogleVerifiedProfile {
  googleId: string;
  email: string;
  name?: string;
  avatar?: string;
  emailVerified: boolean;
}

export interface SessionPayload {
  userId: string;
  email: string;
}

/**
 * Verifies a Google ID token from the frontend using official Google OAuth2Client.
 * Validates audience, issuer, expiration, and ensures email is verified by Google.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleVerifiedProfile> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Google ID token is required');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured on the server');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: clientId,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('Failed to extract verified payload from Google token');
  }

  // Validate Issuer
  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!payload.iss || !validIssuers.includes(payload.iss)) {
    throw new Error(`Invalid token issuer: ${payload.iss}`);
  }

  // Reject unverified emails
  if (!payload.email_verified) {
    throw new Error('Google account email is not verified. Unverified accounts cannot authenticate.');
  }

  if (!payload.email) {
    throw new Error('Google token does not contain an email address');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name || payload.email.split('@')[0],
    avatar: payload.picture,
    emailVerified: true,
  };
}

/**
 * Finds or creates a User in PostgreSQL based on verified Google profile data.
 * Safe account-linking: links googleId if an existing user matches the verified email.
 */
export async function findOrCreateGoogleUser(profile: GoogleVerifiedProfile) {
  // 1. Try finding by googleId first
  let user = await prisma.user.findUnique({
    where: { googleId: profile.googleId },
  });

  if (user) {
    // Update profile info in case name or avatar changed on Google
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: profile.name || user.name,
        avatar: profile.avatar || user.avatar,
        email: profile.email,
      },
    });
    return user;
  }

  // 2. Try finding by verified email (account linking)
  user = await prisma.user.findUnique({
    where: { email: profile.email },
  });

  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        googleId: profile.googleId,
        name: profile.name || user.name,
        avatar: profile.avatar || user.avatar,
      },
    });
    return user;
  }

  // 3. Create new User record
  user = await prisma.user.create({
    data: {
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
      googleId: profile.googleId,
    },
  });

  return user;
}

/**
 * Issues a signed JWT application session token for an authenticated user.
 */
export function generateSessionToken(user: { id: string; email: string }): string {
  const payload: SessionPayload = {
    userId: user.id,
    email: user.email,
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as any,
  });
}

/**
 * Verifies and decodes an application session JWT.
 */
export function verifySessionToken(token: string): SessionPayload {
  return jwt.verify(token, JWT_SECRET) as SessionPayload;
}
