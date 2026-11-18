import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Redis } from 'ioredis';
import { prisma } from '../../src/config/prisma.js';
import { redisConnection } from '../../src/config/redis.js';
import { DistributedLock } from '../../src/utils/distributed-lock.js';
import {
  checkAndIncrementHourlyLimit,
  checkSenderDelayThrottle,
  getNextHourStaggeredTimestamp,
  resetSenderRateLimit,
} from '../../src/services/rate-limiter.service.js';

describe('1000-Job Load Simulation & Stress Verification', () => {
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

  it('reliably schedules and processes 1000 concurrent jobs under strict hourly limits with zero dropped jobs', async () => {
    const TOTAL_JOBS = 1000;
    const HOURLY_LIMIT = 25; // Small hourly limit to test rate limiting under massive load
    const MIN_DELAY_SECONDS = 1;
    const senderId = `load_sender_${Date.now()}`;

    await resetSenderRateLimit(senderId);

    console.log(`\n🚀 [Load Test] Creating ${TOTAL_JOBS} test EmailJob records in PostgreSQL...`);

    // Create 1000 EmailJob records in DB in chunks to keep DB memory lean
    const batchSize = 200;
    for (let b = 0; b < TOTAL_JOBS / batchSize; b++) {
      const records = Array.from({ length: batchSize }, (_, i) => ({
        recipient: `lead_${b * batchSize + i}@target-company.io`,
        subject: `Load Test Email #${b * batchSize + i}`,
        body: 'Scale and reliability verification payload',
        status: 'SCHEDULED' as const,
        scheduledAt: new Date(),
        hourlyLimit: HOURLY_LIMIT,
        delayBetweenEmails: MIN_DELAY_SECONDS,
      }));

      const created = await prisma.emailJob.createManyAndReturn({
        data: records,
        select: { id: true },
      });

      created.forEach((c) => createdJobIds.push(c.id));
    }

    assert.strictEqual(createdJobIds.length, TOTAL_JOBS, '1000 records must be created');

    console.log(`✅ [Load Test] 1000 EmailJob rows created. Simulating multi-worker execution pipeline...`);

    // In-memory fake SMTP sink (no external network calls to avoid hitting Ethereal quotas)
    const sentEmails: Array<{ emailJobId: string; sentAt: number }> = [];
    const rateLimitedEmails: Array<{ emailJobId: string; rescheduledTo: Date; newJobId: string }> = [];

    // Worker pipeline simulator executing the exact production worker logic across 10 concurrent workers
    async function processJob(emailJobId: string, workerName: string) {
      const lockKey = `lock:email:${emailJobId}`;
      const lockHandle = await lock.acquire(lockKey, 30000, workerName);
      if (!lockHandle) {
        return { status: 'skipped_locked' };
      }

      try {
        // Atomic Hourly Limit Check
        const rateLimitCheck = await checkAndIncrementHourlyLimit(senderId, HOURLY_LIMIT);

        if (!rateLimitCheck.allowed) {
          // Rate limited: calculate staggered reschedule timestamp
          const nextTimestamp = await getNextHourStaggeredTimestamp(senderId, MIN_DELAY_SECONDS);
          const newJobId = `${emailJobId}:rate_limit:1`;

          await prisma.emailJob.update({
            where: { id: emailJobId },
            data: {
              status: 'RATE_LIMITED',
              scheduledAt: nextTimestamp,
              jobId: newJobId,
            },
          });

          rateLimitedEmails.push({
            emailJobId,
            rescheduledTo: nextTimestamp,
            newJobId,
          });

          return { status: 'rate_limited' };
        }

        // Throttle check
        await checkSenderDelayThrottle(senderId, MIN_DELAY_SECONDS);

        // Transition to PROCESSING
        await prisma.emailJob.updateMany({
          where: { id: emailJobId, status: { in: ['SCHEDULED', 'RATE_LIMITED'] } },
          data: { status: 'PROCESSING' },
        });

        // Fake SMTP dispatch
        const sentTime = Date.now();
        sentEmails.push({ emailJobId, sentAt: sentTime });

        // Update DB to SENT
        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'SENT',
            sentAt: new Date(sentTime),
            etherealPreviewUrl: `https://ethereal.email/message/fake_${emailJobId}`,
            etherealMessageId: `<msg_${emailJobId}@ethereal.test>`,
          },
        });

        return { status: 'sent' };
      } finally {
        await lockHandle.release();
      }
    }

    // Run 1000 jobs through 10 worker pools concurrently
    const CONCURRENCY = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < createdJobIds.length; i += CONCURRENCY) {
      chunks.push(createdJobIds.slice(i, i + CONCURRENCY));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map((id, idx) => processJob(id, `worker_${idx % CONCURRENCY}`)));
    }

    console.log(`\n📊 [Load Test Results]:`);
    console.log(`   - Total Jobs Processed: ${sentEmails.length + rateLimitedEmails.length}`);
    console.log(`   - Sent this hour: ${sentEmails.length} (Configured Limit: ${HOURLY_LIMIT})`);
    console.log(`   - Rate-Limited & Rescheduled: ${rateLimitedEmails.length}`);

    // Verification 1: Exactly HOURLY_LIMIT emails sent in current hour
    assert.strictEqual(
      sentEmails.length,
      HOURLY_LIMIT,
      `Exactly ${HOURLY_LIMIT} emails should be sent, but got ${sentEmails.length}`
    );

    // Verification 2: Zero duplicate sends (all sent IDs are unique)
    const uniqueSentIds = new Set(sentEmails.map((s) => s.emailJobId));
    assert.strictEqual(uniqueSentIds.size, HOURLY_LIMIT, 'Every sent email must be unique');

    // Verification 3: Remaining 975 emails are all RATE_LIMITED and scheduled for next hour window
    assert.strictEqual(
      rateLimitedEmails.length,
      TOTAL_JOBS - HOURLY_LIMIT,
      `Exactly ${TOTAL_JOBS - HOURLY_LIMIT} emails should be rescheduled, but got ${rateLimitedEmails.length}`
    );

    // Verification 4: Zero jobs disappeared (Total accounted for = 1000)
    assert.strictEqual(
      sentEmails.length + rateLimitedEmails.length,
      TOTAL_JOBS,
      'Every single one of the 1000 jobs must be accounted for'
    );

    // Verification 5: Verify in PostgreSQL database directly
    const [sentInDb, rateLimitedInDb] = await Promise.all([
      prisma.emailJob.count({ where: { id: { in: createdJobIds }, status: 'SENT' } }),
      prisma.emailJob.count({ where: { id: { in: createdJobIds }, status: 'RATE_LIMITED' } }),
    ]);

    assert.strictEqual(sentInDb, HOURLY_LIMIT, 'Database SENT count must match');
    assert.strictEqual(rateLimitedInDb, TOTAL_JOBS - HOURLY_LIMIT, 'Database RATE_LIMITED count must match');

    console.log(`✅ [Load Test Passed] Zero jobs dropped. Rate limit respected. Database state 100% consistent.`);
    await resetSenderRateLimit(senderId);
  });
});
