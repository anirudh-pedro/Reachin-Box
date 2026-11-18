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
  getHourKey,
} from '../../src/services/rate-limiter.service.js';

describe('Multi-Window Drainage & Eventual Delivery Verification', () => {
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

  it('drains all rescheduled jobs across multiple rate-limit windows until 100% reach SENT status', async () => {
    const TOTAL_EMAILS = 9;
    const HOURLY_LIMIT = 3; // 3 emails per window -> requires exactly 3 windows to fully drain
    const senderId = `drain_sender_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    // 1. Create 9 email records in PostgreSQL
    const emailRecords = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `lead_${i + 1}@multi-window-test.io`,
      subject: `Multi-Window Test Email #${i + 1}`,
      body: 'Testing full lifecycle drainage across rate-limit windows',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({
      data: emailRecords,
      select: { id: true },
    });
    created.forEach((c) => createdJobIds.push(c.id));
    assert.strictEqual(createdJobIds.length, TOTAL_EMAILS);

    // Worker simulation representing exact emailWorker lifecycle
    async function executeWorkerPass(activeEmailIds: string[], windowName: string) {
      const windowSent: string[] = [];
      const windowRescheduled: string[] = [];

      for (const emailJobId of activeEmailIds) {
        const lockKey = `lock:email:${emailJobId}`;
        const lockHandle = await lock.acquire(lockKey, 30000, `drain_worker_${windowName}`);
        if (!lockHandle) continue;

        try {
          const emailRecord = await prisma.emailJob.findUnique({ where: { id: emailJobId } });
          if (!emailRecord || emailRecord.status === 'SENT') {
            continue;
          }

          // Atomic Rate Limit Check
          const rateCheck = await checkAndIncrementHourlyLimit(senderId, HOURLY_LIMIT);

          if (!rateCheck.allowed) {
            // Rate-limited: reschedule with incremented versioned jobId
            const currentRescheduleCount = emailRecord.jobId ? parseInt(emailRecord.jobId.split(':rate_limit:')[1] || '0', 10) : 0;
            const nextRescheduleCount = currentRescheduleCount + 1;
            const newJobId = `${emailJobId}:rate_limit:${nextRescheduleCount}`;
            const nextTimestamp = await getNextHourStaggeredTimestamp(senderId, 1);

            await prisma.emailJob.update({
              where: { id: emailJobId },
              data: {
                status: 'RATE_LIMITED',
                scheduledAt: nextTimestamp,
                jobId: newJobId,
              },
            });

            windowRescheduled.push(emailJobId);
          } else {
            // Throttle & Send
            await checkSenderDelayThrottle(senderId, 1);

            await prisma.emailJob.updateMany({
              where: { id: emailJobId, status: { in: ['SCHEDULED', 'RATE_LIMITED'] } },
              data: { status: 'PROCESSING' },
            });

            // SMTP send success
            await prisma.emailJob.update({
              where: { id: emailJobId },
              data: {
                status: 'SENT',
                sentAt: new Date(),
                etherealPreviewUrl: `https://ethereal.email/message/drain_${emailJobId}`,
                etherealMessageId: `<msg_${emailJobId}@drain.test>`,
              },
            });

            windowSent.push(emailJobId);
          }
        } finally {
          await lockHandle.release();
        }
      }

      return { windowSent, windowRescheduled };
    }

    console.log(`\n--- Starting Window 1 (Initial Run) ---`);
    const pass1 = await executeWorkerPass(createdJobIds, 'w1');
    console.log(`Window 1 results: Sent: ${pass1.windowSent.length}, Rescheduled: ${pass1.windowRescheduled.length}`);
    assert.strictEqual(pass1.windowSent.length, 3, 'Window 1 must send exactly 3 emails');
    assert.strictEqual(pass1.windowRescheduled.length, 6, 'Window 1 must reschedule 6 emails');

    // Simulate Window 2 Rollover (new hour window clears counter for sender)
    console.log(`\n--- Simulating Rollover to Window 2 ---`);
    await resetSenderRateLimit(senderId); // Simulates new hour key in Redis

    const pass2 = await executeWorkerPass(pass1.windowRescheduled, 'w2');
    console.log(`Window 2 results: Sent: ${pass2.windowSent.length}, Rescheduled: ${pass2.windowRescheduled.length}`);
    assert.strictEqual(pass2.windowSent.length, 3, 'Window 2 must send exactly 3 emails');
    assert.strictEqual(pass2.windowRescheduled.length, 3, 'Window 2 must reschedule 3 emails');

    // Simulate Window 3 Rollover
    console.log(`\n--- Simulating Rollover to Window 3 ---`);
    await resetSenderRateLimit(senderId); // Simulates next hour key in Redis

    const pass3 = await executeWorkerPass(pass2.windowRescheduled, 'w3');
    console.log(`Window 3 results: Sent: ${pass3.windowSent.length}, Rescheduled: ${pass3.windowRescheduled.length}`);
    assert.strictEqual(pass3.windowSent.length, 3, 'Window 3 must send the final 3 emails');
    assert.strictEqual(pass3.windowRescheduled.length, 0, 'Window 3 must have 0 rescheduled emails remaining');

    // Final Verification in Database: 100% of emails must be in SENT status
    const allDbEmails = await prisma.emailJob.findMany({
      where: { id: { in: createdJobIds } },
    });

    const sentCount = allDbEmails.filter((e) => e.status === 'SENT').length;
    const rateLimitedCount = allDbEmails.filter((e) => e.status === 'RATE_LIMITED').length;
    const scheduledCount = allDbEmails.filter((e) => e.status === 'SCHEDULED').length;

    assert.strictEqual(sentCount, TOTAL_EMAILS, `All ${TOTAL_EMAILS} emails must have status 'SENT'`);
    assert.strictEqual(rateLimitedCount, 0, 'Zero emails should remain in RATE_LIMITED status');
    assert.strictEqual(scheduledCount, 0, 'Zero emails should remain in SCHEDULED status');

    // Verify all have sentAt timestamp and previewUrl
    allDbEmails.forEach((email) => {
      assert.ok(email.sentAt instanceof Date, 'sentAt must be populated');
      assert.ok(email.etherealPreviewUrl?.startsWith('https://ethereal.email'), 'preview URL must be present');
    });

    console.log(`\n✅ [Multi-Window Drainage Complete] 100% of jobs (${sentCount}/${TOTAL_EMAILS}) delivered across 3 windows with zero dropouts.`);
  });
});
