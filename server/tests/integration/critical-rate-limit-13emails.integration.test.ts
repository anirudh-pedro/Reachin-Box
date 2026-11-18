import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Redis } from 'ioredis';
import { prisma } from '../../src/config/prisma.js';
import { emailQueue, addEmailToQueue } from '../../src/queue/email.queue.js';
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
import { logWorkerExecutionAudit } from '../../src/queue/email.worker.js';

describe('Critical Bug Verification: 13 Emails with Limit 5 & 2-Second Delay', () => {
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

  // Reusable worker execution processor matching production email.worker.ts logic
  async function processEmail(
    emailJobId: string,
    senderId: string,
    hourlyLimit: number,
    delaySeconds: number = 2,
    workerName: string = 'worker-main'
  ) {
    const emailRecord = await prisma.emailJob.findUnique({ where: { id: emailJobId } });
    if (!emailRecord) {
      return { status: 'RECORD_NOT_FOUND' };
    }

    if (emailRecord.status === 'SENT') {
      logWorkerExecutionAudit({
        emailJobId,
        bullMqJobId: emailRecord.jobId || emailJobId,
        recipient: emailRecord.recipient,
        currentStatus: 'SENT',
        scheduledTime: emailRecord.scheduledAt.toISOString(),
        actualWorkerExecutionTime: new Date().toISOString(),
        hourlyQuotaCount: await getHourlyCount(senderId),
        hourlyLimit,
        rateLimitDecision: 'SKIPPED',
        rescheduleReason: 'Already sent',
      });
      return { status: 'ALREADY_SENT' };
    }

    const nowMs = Date.now();
    // Stability Guard: If the email is already in RATE_LIMITED status and its scheduled window has not arrived yet, skip!
    if (emailRecord.status === 'RATE_LIMITED' && emailRecord.scheduledAt.getTime() > nowMs + 500) {
      logWorkerExecutionAudit({
        emailJobId,
        bullMqJobId: emailRecord.jobId || emailJobId,
        recipient: emailRecord.recipient,
        currentStatus: 'RATE_LIMITED',
        scheduledTime: emailRecord.scheduledAt.toISOString(),
        actualWorkerExecutionTime: new Date().toISOString(),
        hourlyQuotaCount: await getHourlyCount(senderId),
        hourlyLimit,
        rateLimitDecision: 'SKIPPED',
        senderNextAvailableTime: emailRecord.scheduledAt.toISOString(),
        rescheduleReason: `Already scheduled for next window at ${emailRecord.scheduledAt.toISOString()}`,
        nextExecutionTimestamp: emailRecord.scheduledAt.toISOString(),
      });
      return { status: 'RATE_LIMITED_FUTURE', scheduledAt: emailRecord.scheduledAt, jobId: emailRecord.jobId };
    }

    const lockKey = `lock:email:${emailJobId}`;
    const lockHandle = await lock.acquire(lockKey, 30000, workerName);
    if (!lockHandle) {
      return { status: 'LOCKED' };
    }

    let hourlyQuotaConsumed = false;

    try {
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

        logWorkerExecutionAudit({
          emailJobId,
          bullMqJobId: newJobId,
          recipient: emailRecord.recipient,
          currentStatus: 'RATE_LIMITED',
          scheduledTime: emailRecord.scheduledAt.toISOString(),
          actualWorkerExecutionTime: new Date().toISOString(),
          hourlyQuotaCount: rateLimitCheck.currentCount,
          hourlyLimit,
          rateLimitDecision: 'RATE_LIMITED',
          senderNextAvailableTime: nextTimestamp.toISOString(),
          rescheduleReason: `Hourly quota limit reached (${rateLimitCheck.currentCount}/${hourlyLimit}). Rescheduled to next window.`,
          nextExecutionTimestamp: nextTimestamp.toISOString(),
        });

        return { status: 'RATE_LIMITED', scheduledAt: nextTimestamp, jobId: newJobId };
      }

      // 2. Inter-send delay throttle with in-process pacing
      const throttleCheck = await checkSenderDelayThrottle(senderId, delaySeconds);
      if (!throttleCheck.allowed) {
        if (throttleCheck.waitMs <= 10000) {
          // In-process wait without mutating DB or rescheduling BullMQ
          await new Promise((resolve) => setTimeout(resolve, throttleCheck.waitMs));
        } else {
          // Extended wait
          const newJobId = `${emailJobId}:throttle:1`;
          await prisma.emailJob.update({
            where: { id: emailJobId },
            data: { jobId: newJobId },
          });
          return { status: 'THROTTLED', scheduledAt: throttleCheck.targetTimestamp, jobId: newJobId };
        }
      }

      // 3. Atomic Hourly Rate Limit Authorization
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

        logWorkerExecutionAudit({
          emailJobId,
          bullMqJobId: newJobId,
          recipient: emailRecord.recipient,
          currentStatus: 'RATE_LIMITED',
          scheduledTime: emailRecord.scheduledAt.toISOString(),
          actualWorkerExecutionTime: new Date().toISOString(),
          hourlyQuotaCount: rateLimitCheck.currentCount,
          hourlyLimit,
          rateLimitDecision: 'RATE_LIMITED',
          senderNextAvailableTime: nextTimestamp.toISOString(),
          rescheduleReason: `Hourly quota limit reached (${rateLimitCheck.currentCount}/${hourlyLimit}). Rescheduled to next window.`,
          nextExecutionTimestamp: nextTimestamp.toISOString(),
        });

        return { status: 'RATE_LIMITED', scheduledAt: nextTimestamp, jobId: newJobId };
      }

      hourlyQuotaConsumed = true;

      // 4. Update status to PROCESSING
      await prisma.emailJob.update({
        where: { id: emailJobId },
        data: { status: 'PROCESSING' },
      });

      // 5. Send email & mark SENT
      const sentTime = new Date();
      await prisma.emailJob.update({
        where: { id: emailJobId },
        data: {
          status: 'SENT',
          sentAt: sentTime,
          etherealMessageId: `<msg_${emailJobId}@test.io>`,
          etherealPreviewUrl: `https://ethereal.email/message/${emailJobId}`,
        },
      });

      logWorkerExecutionAudit({
        emailJobId,
        bullMqJobId: emailRecord.jobId || emailJobId,
        recipient: emailRecord.recipient,
        currentStatus: 'SENT',
        scheduledTime: emailRecord.scheduledAt.toISOString(),
        actualWorkerExecutionTime: sentTime.toISOString(),
        hourlyQuotaCount: rateLimitCheck.currentCount,
        hourlyLimit,
        rateLimitDecision: 'AUTHORIZED',
        senderNextAvailableTime: throttleCheck.targetTimestamp.toISOString(),
        rescheduleReason: null,
        nextExecutionTimestamp: null,
      });

      return { status: 'SENT', sentAt: sentTime };
    } catch (err) {
      if (hourlyQuotaConsumed) {
        await decrementHourlyLimit(senderId);
      }
      throw err;
    } finally {
      await lockHandle.release();
    }
  }

  it('Regression Test 1: Schedule 3 emails with a limit of 5: all 3 must be sent', async () => {
    const senderId = `test1_reg_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 3 }, (_, i) => ({
      recipient: `reg1_${i + 1}@domain.io`,
      subject: `Test 1 Email #${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 200), // 200ms spacing for fast test execution
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0.2,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, HOURLY_LIMIT, 0.2));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 3, 'All 3 emails must be SENT');
    assert.strictEqual(rescheduled, 0, '0 emails rescheduled');
    assert.strictEqual(await getHourlyCount(senderId), 3, 'Redis counter must be 3');
  });

  it('Regression Test 2: Schedule 5 emails with a limit of 5: all 5 must be sent', async () => {
    const senderId = `test2_reg_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 5 }, (_, i) => ({
      recipient: `reg2_${i + 1}@domain.io`,
      subject: `Test 2 Email #${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 200),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0.2,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, HOURLY_LIMIT, 0.2));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 5, 'All 5 emails must be SENT');
    assert.strictEqual(rescheduled, 0, '0 emails rescheduled');
    assert.strictEqual(await getHourlyCount(senderId), 5, 'Redis counter must be exactly 5');
  });

  let test3SentTimestamps: Date[] = [];
  let test3RescheduledIds: string[] = [];
  let test3CreatedIds: string[] = [];
  let test3SenderId: string;

  it('Regression Test 3: Schedule 13 emails with a limit of 5: exactly 5 sent and 8 rescheduled', async () => {
    test3SenderId = `test3_reg_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    await resetSenderRateLimit(test3SenderId);

    const TOTAL_EMAILS = 13;
    const records = Array.from({ length: TOTAL_EMAILS }, (_, i) => ({
      recipient: `reg3_lead_${i + 1}@company.com`,
      subject: `Outreach Email #${i + 1}`,
      body: 'Outreach payload for 13 emails test',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 200),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0.2, // 200ms spacing for fast test execution
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => {
      createdJobIds.push(c.id);
      test3CreatedIds.push(c.id);
    });

    const results = [];
    for (const item of created) {
      const res = await processEmail(item.id, test3SenderId, HOURLY_LIMIT, 0.2);
      results.push({ id: item.id, ...res });
    }

    const sentJobs = results.filter((r) => r.status === 'SENT');
    const rescheduledJobs = results.filter((r) => r.status === 'RATE_LIMITED');

    test3SentTimestamps = sentJobs.map((j) => (j as any).sentAt);
    test3RescheduledIds = rescheduledJobs.map((j) => j.id);

    console.log(`\n🎯 [Regression Test 3 Results]`);
    console.log(`• Total Scheduled: 13`);
    console.log(`• Hourly Limit:    5`);
    console.log(`• Sent Count:      ${sentJobs.length}`);
    console.log(`• Rescheduled:     ${rescheduledJobs.length}`);

    assert.strictEqual(sentJobs.length, 5, 'Exactly 5 emails must be SENT in current window');
    assert.strictEqual(rescheduledJobs.length, 8, 'Exactly 8 emails must be RESCHEDULED to next window');
    assert.strictEqual(await getHourlyCount(test3SenderId), 5, 'Redis counter must be exactly 5');

    // DB state verification
    const dbSent = await prisma.emailJob.count({
      where: { id: { in: created.map((c) => c.id) }, status: 'SENT' },
    });
    const dbRescheduled = await prisma.emailJob.count({
      where: { id: { in: created.map((c) => c.id) }, status: 'RATE_LIMITED' },
    });
    assert.strictEqual(dbSent, 5, 'PostgreSQL must reflect exactly 5 SENT records');
    assert.strictEqual(dbRescheduled, 8, 'PostgreSQL must reflect exactly 8 RATE_LIMITED records');
  });

  it('Regression Test 4: Verify 2-second spacing between authorized sends', async () => {
    const spacingSenderId = `spacing_sender_${Date.now()}`;
    await resetSenderRateLimit(spacingSenderId);

    // Schedule 2 emails with exact 2-second delay
    const records = Array.from({ length: 2 }, (_, i) => ({
      recipient: `spacing_${i + 1}@domain.io`,
      subject: `Spacing Email #${i + 1}`,
      body: 'Verify 2s spacing',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: 5,
      delayBetweenEmails: 2, // 2-second delay
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const t1 = await processEmail(created[0].id, spacingSenderId, 5, 2);
    const t2 = await processEmail(created[1].id, spacingSenderId, 5, 2);

    assert.strictEqual(t1.status, 'SENT');
    assert.strictEqual(t2.status, 'SENT');

    const gapMs = (t2 as any).sentAt.getTime() - (t1 as any).sentAt.getTime();
    console.log(`⏱️ Verified gap between consecutive sends with 2s delay: ${gapMs}ms`);
    assert.ok(gapMs >= 1950, `Must be at least ~2000ms apart (actual: ${gapMs}ms >= 1950ms)`);
  });

  it('Regression Test 5: Verify the 8 rescheduled jobs do not keep changing timestamps unnecessarily', async () => {
    assert.strictEqual(test3RescheduledIds.length, 8, '8 rescheduled jobs must exist');

    // Capture initial scheduledAt timestamps
    const initialJobs = await prisma.emailJob.findMany({
      where: { id: { in: test3RescheduledIds } },
      select: { id: true, scheduledAt: true, jobId: true },
    });

    const initialTimestampMap = new Map(initialJobs.map((j) => [j.id, j.scheduledAt.getTime()]));

    // Re-run worker pass on the same 8 jobs while quota is still full
    for (const jobId of test3RescheduledIds) {
      await processEmail(jobId, test3SenderId, 5, 0.2);
    }

    // Verify that scheduledAt timestamps DID NOT CHANGE
    const postPassJobs = await prisma.emailJob.findMany({
      where: { id: { in: test3RescheduledIds } },
      select: { id: true, scheduledAt: true, jobId: true },
    });

    for (const postJob of postPassJobs) {
      const initialTime = initialTimestampMap.get(postJob.id);
      assert.strictEqual(
        postJob.scheduledAt.getTime(),
        initialTime,
        `Email ${postJob.id} scheduledAt must remain stable (was ${initialTime}, now ${postJob.scheduledAt.getTime()})`
      );
    }

    console.log('✅ Confirmed: 8 rescheduled jobs remained at completely stable timestamps without drift');
  });

  it('Regression Test 6: Verify all 8 jobs execute after the quota resets', async () => {
    assert.strictEqual(test3RescheduledIds.length, 8);

    // Simulate quota reset (entering the next hourly window)
    await resetSenderRateLimit(test3SenderId);
    assert.strictEqual(await getHourlyCount(test3SenderId), 0, 'New window starts with quota = 0');

    // Make the rescheduled emails eligible in the new window (now >= scheduledAt)
    await prisma.emailJob.updateMany({
      where: { id: { in: test3RescheduledIds } },
      data: { scheduledAt: new Date(Date.now() - 1000) },
    });

    // Pass 1 in Window 2: Next 5 emails should send
    for (const emailId of test3RescheduledIds) {
      await processEmail(emailId, test3SenderId, 5, 0.2);
    }

    const window2Sent = await prisma.emailJob.count({
      where: { id: { in: test3RescheduledIds }, status: 'SENT' },
    });
    const window2RateLimited = await prisma.emailJob.count({
      where: { id: { in: test3RescheduledIds }, status: 'RATE_LIMITED' },
    });

    assert.strictEqual(window2Sent, 5, 'Window 2 must send next 5 emails up to limit');
    assert.strictEqual(window2RateLimited, 3, 'Window 2 must reschedule remaining 3 emails');

    // Simulate Window 3 Quota Reset for remaining 3 emails
    await resetSenderRateLimit(test3SenderId);
    await prisma.emailJob.updateMany({
      where: { id: { in: test3RescheduledIds }, status: 'RATE_LIMITED' },
      data: { scheduledAt: new Date(Date.now() - 1000) },
    });

    const remaining3 = await prisma.emailJob.findMany({
      where: { id: { in: test3RescheduledIds }, status: 'RATE_LIMITED' },
      select: { id: true },
    });
    assert.strictEqual(remaining3.length, 3);

    for (const r of remaining3) {
      await processEmail(r.id, test3SenderId, 5, 0.2);
    }

    // Final total check across all 13 emails of Test 3
    const allSentCount = await prisma.emailJob.count({
      where: { id: { in: test3CreatedIds }, status: 'SENT' },
    });
    assert.strictEqual(allSentCount, 13, '100% of all 13 emails must reach SENT status across windows');
    console.log('✅ Confirmed: All 13 emails successfully delivered with zero loss');
  });

  it('Regression Test 7: Restart the worker and verify scheduled jobs are recovered without duplicates', async () => {
    const senderId = `restart_test_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    // 1. Create a scheduled job
    const email = await prisma.emailJob.create({
      data: {
        recipient: 'crash_recovery@test.io',
        subject: 'Recovery Test Email',
        body: 'Recovery payload',
        status: 'SCHEDULED',
        scheduledAt: new Date(Date.now() + 50),
        hourlyLimit: 5,
        delayBetweenEmails: 0.2,
      },
    });
    createdJobIds.push(email.id);

    // 2. Simulate worker 1 taking job and crashing before DB update
    const newWorker = new DistributedLock(redis);
    const lockHandle = await newWorker.acquire(`lock:email:${email.id}`, 100);
    assert.ok(lockHandle !== null);

    // Lock expires after 100ms (worker crash)
    await new Promise((r) => setTimeout(r, 150));

    // 3. Worker 2 restarts and picks up job
    const result = await processEmail(email.id, senderId, 5, 0.2, 'worker-recovered');
    assert.strictEqual(result.status, 'SENT', 'Recovered worker must successfully process job');

    // 4. Verify idempotent replay does not duplicate
    const replay = await processEmail(email.id, senderId, 5, 0.2, 'worker-replay');
    assert.strictEqual(replay.status, 'ALREADY_SENT', 'Replay must be skipped as already sent');
  });

  it('Regression Test 8: Run multiple workers and verify no rate-limit breaches', async () => {
    const senderId = `multi_worker_reg_${Date.now()}`;
    const HOURLY_LIMIT = 5;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 13 }, (_, i) => ({
      recipient: `multi_lead_${i + 1}@cluster.io`,
      subject: `Multi-Worker Batch #${i + 1}`,
      body: 'Concurrent worker test',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: HOURLY_LIMIT,
      delayBetweenEmails: 0.2,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    // Fire 13 jobs concurrently across 5 distinct workers
    const results = await Promise.all(
      created.map((item, idx) =>
        processEmail(item.id, senderId, HOURLY_LIMIT, 0.2, `concurrent-worker-${(idx % 5) + 1}`)
      )
    );

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    console.log(`\n📊 [Regression Test 8 Multi-Worker Results] SENT: ${sent}, RESCHEDULED: ${rescheduled}`);

    assert.strictEqual(sent, 5, 'Exactly 5 authorized sends under multi-worker concurrency');
    assert.strictEqual(rescheduled, 8, 'Exactly 8 rescheduled under multi-worker concurrency');
    assert.strictEqual(await getHourlyCount(senderId), 5, 'Redis counter must strictly never exceed limit of 5');
  });
});
