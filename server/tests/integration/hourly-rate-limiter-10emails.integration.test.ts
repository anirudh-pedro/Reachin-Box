import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Redis } from 'ioredis';
import { prisma } from '../../src/config/prisma.js';
import { DistributedLock } from '../../src/utils/distributed-lock.js';
import {
  checkAndIncrementHourlyLimit,
  checkSenderDelayThrottle,
  getNextHourStaggeredTimestamp,
  getHourlyCount,
  setHourlyCount,
  resetSenderRateLimit,
  decrementHourlyLimit,
} from '../../src/services/rate-limiter.service.js';

describe('Hourly Rate Limiter - 10 Emails with Limit 5 Verification', () => {
  let redis: Redis;
  let lock: DistributedLock;
  const createdJobIds: string[] = [];

  before(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    lock = new DistributedLock(redis);
    await prisma.$connect();
  });

  after(async () => {
    if (createdJobIds.length > 0) {
      await prisma.emailJob.deleteMany({
        where: { id: { in: createdJobIds } },
      });
    }
    await redis.quit();
    await prisma.$disconnect();
  });

  // Reusable worker pipeline matching production email.worker.ts logic
  async function executeWorkerPass(
    emailJobId: string,
    senderId: string,
    hourlyLimit: number,
    delaySeconds: number = 0,
    workerName: string = 'test-worker'
  ) {
    const lockKey = `lock:email:${emailJobId}`;
    const lockHandle = await lock.acquire(lockKey, 30000, workerName);
    if (!lockHandle) {
      return { status: 'LOCKED_BY_ANOTHER_WORKER' };
    }

    let hourlyQuotaConsumed = false;

    try {
      const emailRecord = await prisma.emailJob.findUnique({ where: { id: emailJobId } });
      if (!emailRecord || emailRecord.status === 'SENT') {
        return { status: 'ALREADY_SENT' };
      }

      // 1. Fast-path check: Is the hourly limit already exhausted?
      const currentHourlyCount = await getHourlyCount(senderId);
      if (currentHourlyCount >= hourlyLimit) {
        const rateLimitCheck = await checkAndIncrementHourlyLimit(senderId, hourlyLimit);
        const nextTimestamp = await getNextHourStaggeredTimestamp(senderId, delaySeconds);
        const newJobId = `${emailJobId}:rate_limit:1`;

        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'RATE_LIMITED',
            scheduledAt: nextTimestamp,
            jobId: newJobId,
          },
        });

        return { status: 'RATE_LIMITED', rescheduledTo: nextTimestamp, newJobId };
      }

      // 2. Inter-send delay throttle
      const throttleCheck = await checkSenderDelayThrottle(senderId, delaySeconds);
      if (!throttleCheck.allowed && throttleCheck.waitMs > 150) {
        const newJobId = `${emailJobId}:throttle:1`;
        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            scheduledAt: throttleCheck.targetTimestamp,
            jobId: newJobId,
          },
        });
        return { status: 'THROTTLED', rescheduledTo: throttleCheck.targetTimestamp };
      }

      // 3. Atomic Hourly Rate Limit Authorization via Redis Lua
      const rateLimitCheck = await checkAndIncrementHourlyLimit(senderId, hourlyLimit);
      if (!rateLimitCheck.allowed) {
        const nextTimestamp = await getNextHourStaggeredTimestamp(senderId, delaySeconds);
        const newJobId = `${emailJobId}:rate_limit:1`;

        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'RATE_LIMITED',
            scheduledAt: nextTimestamp,
            jobId: newJobId,
          },
        });

        return { status: 'RATE_LIMITED', rescheduledTo: nextTimestamp, newJobId };
      }

      hourlyQuotaConsumed = true;

      // 4. Update status to PROCESSING
      await prisma.emailJob.update({
        where: { id: emailJobId },
        data: { status: 'PROCESSING' },
      });

      // 5. Simulate successful SMTP transmission
      await prisma.emailJob.update({
        where: { id: emailJobId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          etherealMessageId: `<msg_${emailJobId}@test.io>`,
          etherealPreviewUrl: `https://ethereal.email/message/${emailJobId}`,
        },
      });

      return { status: 'SENT' };
    } catch (err) {
      if (hourlyQuotaConsumed) {
        await decrementHourlyLimit(senderId);
      }
      throw err;
    } finally {
      await lockHandle.release();
    }
  }

  it('Test 1: Basic hourly limit - 10 emails with limit 5 produces exactly 5 SENT and 5 RESCHEDULED', async () => {
    const senderId = `test1_sender_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    const TOTAL_EMAILS = 10;

    // 1. Clear relevant test Redis keys
    await resetSenderRateLimit(senderId);
    const initialCount = await getHourlyCount(senderId);
    assert.strictEqual(initialCount, 0, 'Counter must start at 0 after reset');

    // 2. Schedule 10 emails for immediate delivery (delay = 0)
    const records = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `lead_${i + 1}@domain.io`,
      subject: `Batch Email #${i + 1}`,
      body: 'Testing hourly limit of 5 with 10 total emails',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: records,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));
    assert.strictEqual(created.length, 10, '10 emails must be scheduled');

    // 3. Process all 10 emails
    const results: Array<{ id: string; status: string }> = [];
    for (const item of created) {
      const res = await executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0);
      results.push({ id: item.id, status: res.status });
    }

    const sentCount = results.filter((r) => r.status === 'SENT').length;
    const rescheduledCount = results.filter((r) => r.status === 'RATE_LIMITED').length;

    console.log(`\n📊 [Test 1 Results] Total: 10, Limit: 5 -> SENT: ${sentCount}, RESCHEDULED: ${rescheduledCount}`);

    // Assertions
    assert.strictEqual(sentCount, 5, 'Exactly 5 emails must be SENT immediately');
    assert.strictEqual(rescheduledCount, 5, 'Exactly 5 emails must be RESCHEDULED to next window');

    // Verify Redis counter
    const redisCount = await getHourlyCount(senderId);
    assert.strictEqual(redisCount, 5, 'Redis counter must be exactly 5');

    // Verify Database state
    const dbRecords = await prisma.emailJob.findMany({
      where: { id: { in: created.map((c) => c.id) } },
    });
    const dbSent = dbRecords.filter((r) => r.status === 'SENT').length;
    const dbRescheduled = dbRecords.filter((r) => r.status === 'RATE_LIMITED').length;
    assert.strictEqual(dbSent, 5, 'Database must have exactly 5 SENT records');
    assert.strictEqual(dbRescheduled, 5, 'Database must have exactly 5 RATE_LIMITED records');
  });

  it('Test 2: Below the limit - 3 emails with limit 5 produces 3 SENT and 0 RESCHEDULED', async () => {
    const senderId = `test2_sender_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    const TOTAL_EMAILS = 3;

    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `below_${i + 1}@domain.io`,
      subject: `Below Limit Email #${i + 1}`,
      body: 'Testing below limit',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: records,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      const res = await executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0);
      results.push(res);
    }

    const sentCount = results.filter((r) => r.status === 'SENT').length;
    const rescheduledCount = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sentCount, 3, 'All 3 emails must be SENT');
    assert.strictEqual(rescheduledCount, 0, '0 emails must be RESCHEDULED');
    assert.strictEqual(await getHourlyCount(senderId), 3, 'Redis counter must be 3');
  });

  it('Test 3: At the limit - exactly 5 emails with limit 5 produces 5 SENT and 0 RESCHEDULED', async () => {
    const senderId = `test3_sender_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    const TOTAL_EMAILS = 5;

    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `at_limit_${i + 1}@domain.io`,
      subject: `At Limit Email #${i + 1}`,
      body: 'Testing exactly at limit',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: records,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      const res = await executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0);
      results.push(res);
    }

    const sentCount = results.filter((r) => r.status === 'SENT').length;
    const rescheduledCount = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sentCount, 5, 'All 5 emails must be SENT');
    assert.strictEqual(rescheduledCount, 0, '0 emails must be RESCHEDULED');
    assert.strictEqual(await getHourlyCount(senderId), 5, 'Redis counter must be exactly 5');
  });

  it('Test 4: Multiple workers - 10 emails processed concurrently authorizes exactly 5 sends', async () => {
    const senderId = `test4_sender_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    const TOTAL_EMAILS = 10;

    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `multi_worker_${i + 1}@domain.io`,
      subject: `Concurrent Email #${i + 1}`,
      body: 'Testing multi-worker concurrency',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: records,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));

    // Process all 10 jobs concurrently with 5 distinct simulated workers
    const results = await Promise.all(
      created.map((item, idx) =>
        executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0, `worker-${(idx % 5) + 1}`)
      )
    );

    const sentCount = results.filter((r) => r.status === 'SENT').length;
    const rescheduledCount = results.filter((r) => r.status === 'RATE_LIMITED').length;

    console.log(
      `📊 [Test 4 Multi-Worker Results] SENT: ${sentCount}, RESCHEDULED: ${rescheduledCount}, Redis Counter: ${await getHourlyCount(senderId)}`
    );

    assert.strictEqual(sentCount, 5, 'Exactly 5 sends authorized under concurrent multi-worker execution');
    assert.strictEqual(rescheduledCount, 5, 'Exactly 5 sends rescheduled to next window');
    assert.strictEqual(await getHourlyCount(senderId), 5, 'Redis counter must strictly never exceed 5');
  });

  it('Test 5: Quota reset - rescheduled emails become eligible and send after window reset', async () => {
    const senderId = `test5_sender_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    const TOTAL_EMAILS = 10;

    await resetSenderRateLimit(senderId);

    // Initial 10 emails
    const records = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `quota_reset_${i + 1}@domain.io`,
      subject: `Quota Reset Email #${i + 1}`,
      body: 'Testing quota reset and drainage',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: records,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));

    // Window 1
    const pass1 = [];
    for (const item of created) {
      pass1.push(await executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0));
    }
    assert.strictEqual(pass1.filter((r) => r.status === 'SENT').length, 5);
    assert.strictEqual(pass1.filter((r) => r.status === 'RATE_LIMITED').length, 5);

    // Simulate Window 2 Quota Reset (simulates moving to the next UTC hour)
    await resetSenderRateLimit(senderId);
    assert.strictEqual(await getHourlyCount(senderId), 0, 'New window starts with count 0');

    // Window 2: Process the remaining rescheduled emails
    const remainingEmails = await prisma.emailJob.findMany({
      where: { id: { in: created.map((c) => c.id) }, status: 'RATE_LIMITED' },
    });
    assert.strictEqual(remainingEmails.length, 5, '5 emails were waiting in RATE_LIMITED status');

    const pass2 = [];
    for (const item of remainingEmails) {
      pass2.push(await executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0));
    }

    const pass2Sent = pass2.filter((r) => r.status === 'SENT').length;
    assert.strictEqual(pass2Sent, 5, 'All 5 previously rescheduled emails must be sent in Window 2');

    // Total verification across both windows
    const totalSentInDb = await prisma.emailJob.count({
      where: { id: { in: created.map((c) => c.id) }, status: 'SENT' },
    });
    assert.strictEqual(totalSentInDb, 10, '100% of emails (10/10) must be delivered with zero dropped emails');
  });

  it('Test 6: Existing Redis state - handles pre-consumed quota and tests setup properly', async () => {
    const senderId = `test6_sender_${Date.now()}`;
    const HOURLY_LIMIT = 5;

    // Simulate existing Redis state where quota was already consumed by prior sends
    await setHourlyCount(senderId, 5);
    const preCount = await getHourlyCount(senderId);
    assert.strictEqual(preCount, 5, 'Redis state must reflect pre-existing 5 sends');

    // Schedule 3 new emails
    const records = Array.from({ length: 3 }, (_, i) => ({
      recipient: `stale_test_${i + 1}@domain.io`,
      subject: `Stale State Email #${i + 1}`,
      body: 'Testing pre-existing quota state',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: records,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));

    // When processed with quota already consumed, all 3 must be rescheduled
    const results = [];
    for (const item of created) {
      results.push(await executeWorkerPass(item.id, senderId, HOURLY_LIMIT, 0));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 0, '0 emails sent because quota was pre-consumed');
    assert.strictEqual(rescheduled, 3, 'All 3 emails must be rescheduled to next window');

    // Now test proper reset setup:
    await resetSenderRateLimit(senderId);
    assert.strictEqual(await getHourlyCount(senderId), 0, 'Quota cleanly reset');

    // Re-processing now succeeds
    const retry = await executeWorkerPass(created[0].id, senderId, HOURLY_LIMIT, 0);
    assert.strictEqual(retry.status, 'SENT', 'Email can now send after clean reset');
  });
});
