import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import express from 'express';
import { prisma } from '../../src/config/prisma.js';
import {
  findOrCreateGoogleUser,
  generateSessionToken,
} from '../../src/services/auth.service.js';
import { emailQueue } from '../../src/queue/email.queue.js';
import { redisConnection } from '../../src/config/redis.js';
import authRoutes from '../../src/routes/auth.routes.js';
import emailRoutes from '../../src/routes/email.routes.js';

describe('Production Google Auth & Multi-Tenant Security Integration Tests', () => {
  let server: http.Server;
  let baseUrl: string;
  const createdUserIds: string[] = [];
  const createdEmailIds: string[] = [];

  let userA: { id: string; email: string; token: string };
  let userB: { id: string; email: string; token: string };

  before(async () => {
    await prisma.$connect();

    // Spin up an in-memory test Express instance mounting the real production routes
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/emails', emailRoutes);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 1. Create User A in DB
    const uA = await findOrCreateGoogleUser({
      googleId: `google_uid_A_${Date.now()}`,
      email: `user.alpha.${Date.now()}@reachinbox.test`,
      name: 'Alpha Tester',
      avatar: 'https://lh3.googleusercontent.com/avatar_a.png',
      emailVerified: true,
    });
    createdUserIds.push(uA.id);
    userA = { id: uA.id, email: uA.email, token: generateSessionToken(uA) };

    // 2. Create User B in DB
    const uB = await findOrCreateGoogleUser({
      googleId: `google_uid_B_${Date.now()}`,
      email: `user.beta.${Date.now()}@reachinbox.test`,
      name: 'Beta Tester',
      avatar: 'https://lh3.googleusercontent.com/avatar_b.png',
      emailVerified: true,
    });
    createdUserIds.push(uB.id);
    userB = { id: uB.id, email: uB.email, token: generateSessionToken(uB) };
  });

  after(async () => {
    if (createdEmailIds.length > 0) {
      await prisma.emailJob.deleteMany({
        where: { id: { in: createdEmailIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
    if (server) {
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await prisma.$disconnect();
  });

  it('creates a new user in PostgreSQL upon first Google authentication', async () => {
    const timestamp = Date.now();
    const googleId = `google_sub_new_${timestamp}`;
    const email = `new.registration.${timestamp}@reachinbox.test`;

    const newUser = await findOrCreateGoogleUser({
      googleId,
      email,
      name: 'New Registered User',
      avatar: 'https://lh3.googleusercontent.com/photo_new.jpg',
      emailVerified: true,
    });

    createdUserIds.push(newUser.id);

    assert.ok(newUser.id, 'User record must have a UUID');
    assert.strictEqual(newUser.email, email);
    assert.strictEqual(newUser.googleId, googleId);
    assert.strictEqual(newUser.name, 'New Registered User');

    // Verify in database directly
    const dbRecord = await prisma.user.findUnique({ where: { id: newUser.id } });
    assert.ok(dbRecord, 'User must exist in PostgreSQL');
    assert.strictEqual(dbRecord?.googleId, googleId);
  });

  it('updates profile and avoids duplicate records on subsequent login of existing user', async () => {
    const updatedUser = await findOrCreateGoogleUser({
      googleId: userA.id, // using existing googleId
      email: userA.email,
      name: 'Alpha Tester Renamed',
      avatar: 'https://lh3.googleusercontent.com/avatar_a_new.png',
      emailVerified: true,
    });

    const userCount = await prisma.user.count({ where: { email: userA.email } });
    assert.strictEqual(userCount, 1, 'Never create duplicate user records');
    assert.strictEqual(updatedUser.name, 'Alpha Tester Renamed');
  });

  it('safely links googleId if user with verified email already existed in database', async () => {
    const timestamp = Date.now();
    const existingEmail = `preexisting.${timestamp}@reachinbox.test`;

    // Create user before Google was linked (e.g. from prior invite or manual seed)
    const initialUser = await prisma.user.create({
      data: {
        email: existingEmail,
        name: 'Pre-existing Account',
      },
    });
    createdUserIds.push(initialUser.id);
    assert.strictEqual(initialUser.googleId, null);

    // Now user logs in with Google using that same verified email
    const linkedUser = await findOrCreateGoogleUser({
      googleId: `google_linked_${timestamp}`,
      email: existingEmail,
      name: 'Pre-existing Account Linked',
      avatar: 'https://lh3.googleusercontent.com/linked_pic.png',
      emailVerified: true,
    });

    assert.strictEqual(linkedUser.id, initialUser.id, 'Must link to the same PostgreSQL row');
    assert.strictEqual(linkedUser.googleId, `google_linked_${timestamp}`, 'Must populate googleId');
  });

  it('rejects unauthenticated requests to protected email APIs with 401 Unauthorized', async () => {
    // 1. Missing Authorization header
    await assert.rejects(
      async () => {
        await axios.get(`${baseUrl}/api/emails/scheduled`);
      },
      (err: any) => {
        assert.strictEqual(err.response?.status, 401);
        assert.strictEqual(err.response?.data?.error, 'Unauthorized');
        return true;
      }
    );

    // 2. Invalid Bearer token
    await assert.rejects(
      async () => {
        await axios.get(`${baseUrl}/api/emails/scheduled`, {
          headers: { Authorization: 'Bearer invalid.bogus.jwt.token' },
        });
      },
      (err: any) => {
        assert.strictEqual(err.response?.status, 401);
        return true;
      }
    );
  });

  it('authenticates valid session token on GET /api/auth/me', async () => {
    const res = await axios.get(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.user.id, userA.id);
    assert.strictEqual(res.data.user.email, userA.email);
  });

  it('strictly isolates tenant data: User B cannot access User A scheduled emails or stats', async () => {
    // 1. User A schedules an email
    const scheduleRes = await axios.post(
      `${baseUrl}/api/emails/schedule`,
      {
        recipients: ['client.prospect@fortune500.com'],
        subject: 'User A Secret Pitch',
        body: 'Confidential strategy presentation details',
      },
      {
        headers: { Authorization: `Bearer ${userA.token}` },
      }
    );

    assert.strictEqual(scheduleRes.status, 201);
    const createdJob = scheduleRes.data.jobs[0];
    createdEmailIds.push(createdJob.id);
    assert.strictEqual(createdJob.userId, userA.id, 'Job must be linked to User A');

    // 2. User A can see their own scheduled email
    const userAList = await axios.get(`${baseUrl}/api/emails/scheduled`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    const foundByA = userAList.data.data.find((e: any) => e.id === createdJob.id);
    assert.ok(foundByA, 'User A must see their scheduled email');

    // 3. User B queries scheduled emails -> User A email is completely invisible
    const userBList = await axios.get(`${baseUrl}/api/emails/scheduled`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    const foundByB = userBList.data.data.find((e: any) => e.id === createdJob.id);
    assert.strictEqual(foundByB, undefined, 'User B must NOT see User A scheduled email');

    // 4. User B attempts direct access to User A email by ID -> 404 Not Found (Cross-tenant prevention)
    await assert.rejects(
      async () => {
        await axios.get(`${baseUrl}/api/emails/${createdJob.id}`, {
          headers: { Authorization: `Bearer ${userB.token}` },
        });
      },
      (err: any) => {
        assert.strictEqual(err.response?.status, 404, 'Must return 404 to prevent enumeration of other users IDs');
        return true;
      }
    );

    // 5. User A can view their email by ID successfully
    const getResA = await axios.get(`${baseUrl}/api/emails/${createdJob.id}`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    assert.strictEqual(getResA.status, 200);
    assert.strictEqual(getResA.data.data.id, createdJob.id);

    // 6. User B stats must not count User A emails
    const statsResB = await axios.get(`${baseUrl}/api/emails/stats`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    assert.strictEqual(statsResB.data.stats.scheduled, 0, 'User B scheduled count must be 0');
  });

  it('handles logout endpoint cleanly', async () => {
    const res = await axios.post(
      `${baseUrl}/api/auth/logout`,
      {},
      {
        headers: { Authorization: `Bearer ${userA.token}` },
      }
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
  });
});
