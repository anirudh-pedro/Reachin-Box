import { describe, it } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import {
  generateSessionToken,
  verifySessionToken,
} from '../src/services/auth.service.js';

describe('Google OAuth & Session JWT Unit Tests', () => {
  const TEST_JWT_SECRET = process.env.JWT_SECRET || 'reachinbox_default_dev_jwt_secret_32bytes_random_dev_only!';

  it('generates a valid signed JWT containing userId and email', () => {
    const user = { id: 'usr_abc123', email: 'test.user@outbox.ai' };
    const token = generateSessionToken(user);

    assert.ok(token, 'Token must be generated');
    assert.strictEqual(typeof token, 'string');

    const decoded = verifySessionToken(token);
    assert.strictEqual(decoded.userId, user.id);
    assert.strictEqual(decoded.email, user.email);
  });

  it('rejects tampered or forged JWT tokens with invalid signature', () => {
    const user = { id: 'usr_real', email: 'real@outbox.ai' };
    const validToken = generateSessionToken(user);

    // Tamper with payload
    const parts = validToken.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ userId: 'usr_hacker', email: 'hacker@evil.com' })).toString('base64url');
    const forgedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    assert.throws(
      () => {
        verifySessionToken(forgedToken);
      },
      (err: any) => {
        return err.name === 'JsonWebTokenError';
      },
      'Tampered token must fail signature verification'
    );
  });

  it('rejects tokens signed with an unauthorized external secret', () => {
    const foreignToken = jwt.sign(
      { userId: 'usr_imposter', email: 'imposter@fake.com' },
      'completely_different_untrusted_secret_key_12345',
      { expiresIn: '1h' }
    );

    assert.throws(
      () => {
        verifySessionToken(foreignToken);
      },
      (err: any) => {
        return err.name === 'JsonWebTokenError';
      },
      'Token signed by untrusted secret must be rejected'
    );
  });

  it('rejects expired session tokens with TokenExpiredError', () => {
    const expiredToken = jwt.sign(
      { userId: 'usr_expired', email: 'expired@outbox.ai' },
      TEST_JWT_SECRET,
      { expiresIn: '-10s' } // Expired 10 seconds ago
    );

    assert.throws(
      () => {
        verifySessionToken(expiredToken);
      },
      (err: any) => {
        return err.name === 'TokenExpiredError';
      },
      'Expired token must be rejected'
    );
  });

  it('simulates Google ID token validation rules: enforces email_verified and correct audience', () => {
    // Pure function simulating Google ID token payload validation logic
    function validateMockGooglePayload(payload: any, expectedAudience: string) {
      if (!payload.sub) throw new Error('Missing sub (googleId)');
      if (!payload.email) throw new Error('Missing email');
      if (payload.aud !== expectedAudience) throw new Error(`Wrong audience: expected ${expectedAudience}, got ${payload.aud}`);
      if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('Invalid issuer');
      if (!payload.email_verified) throw new Error('Email is not verified by Google');
      return {
        googleId: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name,
        avatar: payload.picture,
        emailVerified: true,
      };
    }

    const EXPECTED_AUD = 'reachinbox-client-123.apps.googleusercontent.com';

    // 1. Valid payload
    const validPayload = {
      sub: 'google_sub_998877',
      email: 'verified.lead@reachinbox.test',
      email_verified: true,
      aud: EXPECTED_AUD,
      iss: 'https://accounts.google.com',
      name: 'Alex Rivera',
      picture: 'https://lh3.googleusercontent.com/photo.jpg',
    };
    const result = validateMockGooglePayload(validPayload, EXPECTED_AUD);
    assert.strictEqual(result.googleId, 'google_sub_998877');
    assert.strictEqual(result.email, 'verified.lead@reachinbox.test');
    assert.strictEqual(result.emailVerified, true);

    // 2. Audience mismatch (Token stolen from another Google Cloud project)
    assert.throws(
      () => {
        validateMockGooglePayload({ ...validPayload, aud: 'attacker-client-app.apps.googleusercontent.com' }, EXPECTED_AUD);
      },
      /Wrong audience/,
      'Token with wrong audience must be rejected'
    );

    // 3. Unverified email
    assert.throws(
      () => {
        validateMockGooglePayload({ ...validPayload, email_verified: false }, EXPECTED_AUD);
      },
      /Email is not verified by Google/,
      'Unverified Google email must be rejected'
    );

    // 4. Invalid issuer
    assert.throws(
      () => {
        validateMockGooglePayload({ ...validPayload, iss: 'https://phishing-site.com' }, EXPECTED_AUD);
      },
      /Invalid issuer/,
      'Untrusted issuer must be rejected'
    );
  });
});
