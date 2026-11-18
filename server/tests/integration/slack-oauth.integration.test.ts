import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import axios from 'axios';
import express from 'express';
import { prisma } from '../../src/config/prisma.js';
import { redisConnection } from '../../src/config/redis.js';
import {
  findOrCreateGoogleUser,
  generateSessionToken,
} from '../../src/services/auth.service.js';
import { encryptToken, decryptToken } from '../../src/utils/encryption.js';
import { sendSlackRateLimitAlert } from '../../src/services/slack.service.js';
import authRoutes from '../../src/routes/auth.routes.js';
import slackRoutes from '../../src/routes/slack.routes.js';

describe('Multi-Tenant Slack OAuth 2.0 & Token Security Integration Tests', () => {
  let server: http.Server;
  let baseUrl: string;
  const createdUserIds: string[] = [];

  let userA: { id: string; email: string; token: string };
  let userB: { id: string; email: string; token: string };

  before(async () => {
    process.env.SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'mock_slack_client_id_12345';
    process.env.SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'mock_slack_client_secret_67890';
    process.env.SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'http://localhost:5000/api/auth/slack/callback';

    await prisma.$connect();

    // In-memory test Express app with production auth and slack routes
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/auth/slack', slackRoutes);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 1. Provision User A (Acme Corp tenant)
    const uA = await findOrCreateGoogleUser({
      googleId: `slack_tenant_A_${Date.now()}`,
      email: `alice.acme.${Date.now()}@reachinbox.test`,
      name: 'Alice Acme',
      emailVerified: true,
    });
    createdUserIds.push(uA.id);
    userA = { id: uA.id, email: uA.email, token: generateSessionToken(uA) };

    // 2. Provision User B (Globex Industries tenant)
    const uB = await findOrCreateGoogleUser({
      googleId: `slack_tenant_B_${Date.now()}`,
      email: `bob.globex.${Date.now()}@reachinbox.test`,
      name: 'Bob Globex',
      emailVerified: true,
    });
    createdUserIds.push(uB.id);
    userB = { id: uB.id, email: uB.email, token: generateSessionToken(uB) };
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await prisma.slackIntegration.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
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

  it('generates a secure, unpredictable OAuth state bound to the authenticated user in Redis', async () => {
    // 1. Unauthenticated request must be rejected
    await assert.rejects(
      async () => {
        await axios.get(`${baseUrl}/api/auth/slack/url`);
      },
      (err: any) => {
        assert.strictEqual(err.response?.status, 401);
        return true;
      }
    );

    // 2. Authenticated request for User A
    const res = await axios.get(`${baseUrl}/api/auth/slack/url`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.url, 'Must return authorization URL');
    assert.ok(res.data.state, 'Must return generated state');
    assert.strictEqual(res.data.state.length, 64, 'State must be a 32-byte hex string (64 chars)');

    // 3. Verify state binding in Redis
    const stateKey = `slack:oauth:state:${res.data.state}`;
    const rawData = await redisConnection.get(stateKey);
    assert.ok(rawData, 'State must be present in Redis');

    const parsed = JSON.parse(rawData);
    assert.strictEqual(parsed.userId, userA.id, 'State must be strictly bound to User A');

    const ttl = await redisConnection.ttl(stateKey);
    assert.ok(ttl > 0 && ttl <= 600, 'State must have TTL of ~10 minutes');

    // Clean up test key
    await redisConnection.del(stateKey);
  });

  it('rejects invalid, forged, or expired OAuth state parameters during callback (CSRF prevention)', async () => {
    // Callback with a bogus/forged state that does not exist in Redis
    const bogusState = 'deadbeef'.repeat(8);
    const callbackRes = await axios.get(`${baseUrl}/api/auth/slack/callback?code=mock_code&state=${bogusState}`, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 300 && status < 400, // Expect redirect
    });

    const redirectLocation = callbackRes.headers.location;
    assert.ok(redirectLocation, 'Must redirect on error');
    assert.ok(
      redirectLocation.includes('slack_connected=error') &&
      redirectLocation.includes('Invalid_or_expired_state'),
      'Must redirect to frontend with state validation error'
    );
  });

  it('encrypts Slack tokens at rest in PostgreSQL with AES-256-GCM and isolates tenant integrations', async () => {
    const rawTokenA = 'mock-slack-acme-secret-bot-token-112233';
    const encryptedTokenA = encryptToken(rawTokenA);

    // 1. Simulate completed OAuth setup for User A (Acme Corp)
    await prisma.slackIntegration.upsert({
      where: { userId: userA.id },
      update: {
        teamId: 'T_ACME_001',
        teamName: 'Acme Corp',
        accessToken: encryptedTokenA,
        channelId: 'C_ACME_ALERTS',
        channelName: '#campaign-alerts',
        isActive: true,
      },
      create: {
        userId: userA.id,
        teamId: 'T_ACME_001',
        teamName: 'Acme Corp',
        accessToken: encryptedTokenA,
        channelId: 'C_ACME_ALERTS',
        channelName: '#campaign-alerts',
        isActive: true,
      },
    });

    // 2. Simulate completed OAuth setup for User B (Globex Industries)
    const rawTokenB = 'mock-slack-globex-secret-bot-token-445566';
    const encryptedTokenB = encryptToken(rawTokenB);

    await prisma.slackIntegration.upsert({
      where: { userId: userB.id },
      update: {
        teamId: 'T_GLOBEX_002',
        teamName: 'Globex Industries',
        accessToken: encryptedTokenB,
        channelId: 'C_GLOBEX_NOTIFY',
        channelName: '#lead-notifications',
        isActive: true,
      },
      create: {
        userId: userB.id,
        teamId: 'T_GLOBEX_002',
        teamName: 'Globex Industries',
        accessToken: encryptedTokenB,
        channelId: 'C_GLOBEX_NOTIFY',
        channelName: '#lead-notifications',
        isActive: true,
      },
    });

    // 3. Verify in PostgreSQL database directly: Tokens MUST be encrypted at rest!
    const [dbA, dbB] = await Promise.all([
      prisma.slackIntegration.findUnique({ where: { userId: userA.id } }),
      prisma.slackIntegration.findUnique({ where: { userId: userB.id } }),
    ]);

    assert.ok(dbA && dbB);
    assert.strictEqual(dbA.teamName, 'Acme Corp');
    assert.strictEqual(dbB.teamName, 'Globex Industries');

    // Never stored in plaintext
    assert.ok(!dbA.accessToken.includes('mock-slack-acme'), 'User A token must NOT be plaintext in PostgreSQL');
    assert.ok(!dbB.accessToken.includes('mock-slack-globex'), 'User B token must NOT be plaintext in PostgreSQL');

    // Tokens must be decryptable
    assert.strictEqual(decryptToken(dbA.accessToken), rawTokenA);
    assert.strictEqual(decryptToken(dbB.accessToken), rawTokenB);
  });

  it('enforces multi-tenant isolation on status endpoint and never exposes tokens to the frontend', async () => {
    // 1. User A status check
    const statusResA = await axios.get(`${baseUrl}/api/auth/slack/status`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });

    assert.strictEqual(statusResA.status, 200);
    assert.strictEqual(statusResA.data.connected, true);
    assert.strictEqual(statusResA.data.teamName, 'Acme Corp');
    assert.strictEqual(statusResA.data.channel, '#campaign-alerts');
    assert.strictEqual(statusResA.data.accessToken, undefined, 'Access token must NEVER be exposed');

    // 2. User B status check
    const statusResB = await axios.get(`${baseUrl}/api/auth/slack/status`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });

    assert.strictEqual(statusResB.status, 200);
    assert.strictEqual(statusResB.data.connected, true);
    assert.strictEqual(statusResB.data.teamName, 'Globex Industries');
    assert.strictEqual(statusResB.data.channel, '#lead-notifications');
    assert.strictEqual(statusResB.data.accessToken, undefined, 'Access token must NEVER be exposed');
  });

  it('safely disconnects one user without affecting another user integration', async () => {
    // User B disconnects Slack
    const disconnectRes = await axios.post(
      `${baseUrl}/api/auth/slack/disconnect`,
      {},
      {
        headers: { Authorization: `Bearer ${userB.token}` },
      }
    );

    assert.strictEqual(disconnectRes.status, 200);
    assert.strictEqual(disconnectRes.data.success, true);

    // Verify User B is disconnected
    const statusB = await axios.get(`${baseUrl}/api/auth/slack/status`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    assert.strictEqual(statusB.data.connected, false, 'User B must now report not connected');

    // Verify User A remains CONNECTED and ACTIVE
    const statusA = await axios.get(`${baseUrl}/api/auth/slack/status`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    assert.strictEqual(statusA.data.connected, true, 'User A must remain connected');
    assert.strictEqual(statusA.data.teamName, 'Acme Corp');
  });

  it('allows a user to reconnect Slack and immediately restores active status without server restart', async () => {
    const rawReconnectedToken = 'mock-slack-globex-reconnected-token-998877';

    // User B reconnects with new workspace/channel
    await prisma.slackIntegration.upsert({
      where: { userId: userB.id },
      update: {
        teamId: 'T_GLOBEX_NEW',
        teamName: 'Globex Global Enterprise',
        accessToken: encryptToken(rawReconnectedToken),
        channelId: 'C_GLOBEX_MAIN',
        channelName: '#enterprise-alerts',
        isActive: true,
      },
      create: {
        userId: userB.id,
        teamId: 'T_GLOBEX_NEW',
        teamName: 'Globex Global Enterprise',
        accessToken: encryptToken(rawReconnectedToken),
        channelId: 'C_GLOBEX_MAIN',
        channelName: '#enterprise-alerts',
        isActive: true,
      },
    });

    // Verify User B is immediately active
    const statusB = await axios.get(`${baseUrl}/api/auth/slack/status`, {
      headers: { Authorization: `Bearer ${userB.token}` },
    });
    assert.strictEqual(statusB.data.connected, true);
    assert.strictEqual(statusB.data.teamName, 'Globex Global Enterprise');
    assert.strictEqual(statusB.data.channel, '#enterprise-alerts');
  });

  it('handles rate limit alert dispatch gracefully for disconnected users without throwing or crashing', async () => {
    // User with no Slack integration
    const randomUserId = `usr_random_${Date.now()}`;
    const result = await sendSlackRateLimitAlert({
      userId: randomUserId,
      senderEmail: 'sales@reachinbox.test',
      senderId: 'default-sender',
      hourlyLimit: 100,
      currentCount: 101,
      nextHourTimestamp: new Date(Date.now() + 3600000),
      emailJobId: 'job-unconnected-test',
    });

    // Graceful no-op: returns false without throwing
    assert.strictEqual(result, false, 'Rate limit alert must return false gracefully when user has no Slack integration');
  });
});
