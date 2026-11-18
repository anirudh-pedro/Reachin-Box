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
import { logWorkerExecutionAudit } from '../../src/queue/email.worker.js';

// Parser matching ComposeView.tsx CSV logic
function parseCsvRecipients(csvContent: string): string[] {
  const rawTokens = csvContent
    .split(/[\r\n,;]+/)
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const validEmails: string[] = [];
  const seen = new Set<string>();

  for (const token of rawTokens) {
    if (/^(email|emails|recipient|recipients|name)$/i.test(token)) {
      continue;
    }
    if (emailRegex.test(token)) {
      const lower = token.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        validEmails.push(token);
      }
    }
  }

  return validEmails;
}

describe('Bulk Email Upload & Individual Scheduling Rate Limiting (Limit = 6)', () => {
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

  async function processEmail(
    emailJobId: string,
    senderId: string,
    hourlyLimit: number,
    delaySeconds: number = 0.2,
    workerName: string = 'worker-main'
  ) {
    const emailRecord = await prisma.emailJob.findUnique({ where: { id: emailJobId } });
    if (!emailRecord) return { status: 'RECORD_NOT_FOUND' };
    if (emailRecord.status === 'SENT') return { status: 'ALREADY_SENT' };

    const nowMs = Date.now();
    if (emailRecord.status === 'RATE_LIMITED' && emailRecord.scheduledAt.getTime() > nowMs + 500) {
      return { status: 'RATE_LIMITED_FUTURE', scheduledAt: emailRecord.scheduledAt };
    }

    const lockKey = `lock:email:${emailJobId}`;
    const lockHandle = await lock.acquire(lockKey, 30000, workerName);
    if (!lockHandle) return { status: 'LOCKED' };

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

        return { status: 'RATE_LIMITED', scheduledAt: nextTimestamp, jobId: newJobId };
      }

      // 2. Inter-send delay throttle
      const throttleCheck = await checkSenderDelayThrottle(senderId, delaySeconds);
      if (!throttleCheck.allowed) {
        if (throttleCheck.waitMs <= 10000) {
          await new Promise((resolve) => setTimeout(resolve, throttleCheck.waitMs));
        } else {
          const newJobId = `${emailJobId}:throttle:1`;
          await prisma.emailJob.update({
            where: { id: emailJobId },
            data: { jobId: newJobId },
          });
          return { status: 'THROTTLED', scheduledAt: throttleCheck.targetTimestamp, jobId: newJobId };
        }
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

        return { status: 'RATE_LIMITED', scheduledAt: nextTimestamp, jobId: newJobId };
      }

      hourlyQuotaConsumed = true;

      // 4. Update status to PROCESSING
      await prisma.emailJob.update({
        where: { id: emailJobId },
        data: { status: 'PROCESSING' },
      });

      // 5. Simulate send & mark SENT
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

  // ==========================================
  // Test A: 3 emails, hourly limit = 6
  // ==========================================
  it('Test A (Individual): 3 emails with hourly limit 6 -> 3 SENT, 0 RESCHEDULED', async () => {
    const senderId = `bulk_test_a_indiv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 3 }, (_, i) => ({
      recipient: `indiv_a_${i + 1}@domain.io`,
      subject: `Subject ${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 100),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    assert.strictEqual(results.filter((r) => r.status === 'SENT').length, 3);
    assert.strictEqual(results.filter((r) => r.status === 'RATE_LIMITED').length, 0);
    assert.strictEqual(await getHourlyCount(senderId), 3);
  });

  it('Test A (CSV Bulk Upload): 3 emails with hourly limit 6 -> 3 SENT, 0 RESCHEDULED', async () => {
    const senderId = `bulk_test_a_csv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const csvData = `Email Address\ncsv_a_1@domain.io\ncsv_a_2@domain.io\ncsv_a_3@domain.io`;
    const recipients = parseCsvRecipients(csvData);
    assert.strictEqual(recipients.length, 3);

    const records = recipients.map((email, i) => ({
      recipient: email,
      subject: `CSV Campaign #${i + 1}`,
      body: 'Campaign text',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 100),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    assert.strictEqual(results.filter((r) => r.status === 'SENT').length, 3);
    assert.strictEqual(results.filter((r) => r.status === 'RATE_LIMITED').length, 0);
    assert.strictEqual(await getHourlyCount(senderId), 3);
  });

  // ==========================================
  // Test B: 6 emails, hourly limit = 6
  // ==========================================
  it('Test B (Individual): 6 emails with hourly limit 6 -> 6 SENT, 0 RESCHEDULED', async () => {
    const senderId = `bulk_test_b_indiv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 6 }, (_, i) => ({
      recipient: `indiv_b_${i + 1}@domain.io`,
      subject: `Subject ${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 100),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    assert.strictEqual(results.filter((r) => r.status === 'SENT').length, 6);
    assert.strictEqual(results.filter((r) => r.status === 'RATE_LIMITED').length, 0);
    assert.strictEqual(await getHourlyCount(senderId), 6);
  });

  it('Test B (CSV Bulk Upload): 6 emails with hourly limit 6 -> 6 SENT, 0 RESCHEDULED', async () => {
    const senderId = `bulk_test_b_csv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const csvData = Array.from({ length: 6 }, (_, i) => `csv_b_${i + 1}@domain.io`).join('\n');
    const recipients = parseCsvRecipients(csvData);
    assert.strictEqual(recipients.length, 6);

    const records = recipients.map((email, i) => ({
      recipient: email,
      subject: `CSV Campaign #${i + 1}`,
      body: 'Campaign text',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 100),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    assert.strictEqual(results.filter((r) => r.status === 'SENT').length, 6);
    assert.strictEqual(results.filter((r) => r.status === 'RATE_LIMITED').length, 0);
    assert.strictEqual(await getHourlyCount(senderId), 6);
  });

  // ==========================================
  // Test C: 13 emails, hourly limit = 6
  // ==========================================
  it('Test C (Individual): 13 emails with hourly limit 6 -> 6 SENT, 7 RESCHEDULED', async () => {
    const senderId = `bulk_test_c_indiv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 13 }, (_, i) => ({
      recipient: `indiv_c_${i + 1}@domain.io`,
      subject: `Subject ${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 100),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 6, 'Exactly 6 emails sent in current window');
    assert.strictEqual(rescheduled, 7, 'Exactly 7 emails rescheduled to next window');
    assert.strictEqual(await getHourlyCount(senderId), 6);
  });

  it('Test C (CSV Bulk Upload): 13 emails with hourly limit 6 -> 6 SENT, 7 RESCHEDULED', async () => {
    const senderId = `bulk_test_c_csv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const csvData = `email\n` + Array.from({ length: 13 }, (_, i) => `csv_c_${i + 1}@domain.io`).join('\n');
    const recipients = parseCsvRecipients(csvData);
    assert.strictEqual(recipients.length, 13);

    const records = recipients.map((email, i) => ({
      recipient: email,
      subject: `CSV Campaign #${i + 1}`,
      body: 'Campaign text',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 100),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 6, 'CSV Bulk Upload: Exactly 6 emails sent');
    assert.strictEqual(rescheduled, 7, 'CSV Bulk Upload: Exactly 7 emails rescheduled');
    assert.strictEqual(await getHourlyCount(senderId), 6, 'Redis counter must strictly be 6');
  });

  // ==========================================
  // Test D: 20 emails, hourly limit = 6
  // ==========================================
  it('Test D (Individual): 20 emails with hourly limit 6 -> 6 SENT, 14 RESCHEDULED', async () => {
    const senderId = `bulk_test_d_indiv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const records = Array.from({ length: 20 }, (_, i) => ({
      recipient: `indiv_d_${i + 1}@domain.io`,
      subject: `Subject ${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 50),
      hourlyLimit: 6,
      delayBetweenEmails: 0.05,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.05));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 6, 'Exactly 6 emails sent in current window');
    assert.strictEqual(rescheduled, 14, 'Exactly 14 emails rescheduled to next window');
    assert.strictEqual(await getHourlyCount(senderId), 6);
  });

  it('Test D (CSV Bulk Upload): 20 emails with hourly limit 6 -> 6 SENT, 14 RESCHEDULED', async () => {
    const senderId = `bulk_test_d_csv_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const csvData = `recipients\n` + Array.from({ length: 20 }, (_, i) => `csv_d_${i + 1}@domain.io`).join('\n');
    const recipients = parseCsvRecipients(csvData);
    assert.strictEqual(recipients.length, 20);

    const records = recipients.map((email, i) => ({
      recipient: email,
      subject: `CSV Campaign #${i + 1}`,
      body: 'Campaign text',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(Date.now() + i * 50),
      hourlyLimit: 6,
      delayBetweenEmails: 0.05,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.05));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 6, 'CSV Bulk Upload: Exactly 6 emails sent');
    assert.strictEqual(rescheduled, 14, 'CSV Bulk Upload: Exactly 14 emails rescheduled');
    assert.strictEqual(await getHourlyCount(senderId), 6, 'Redis counter must strictly be 6');
  });

  // ==========================================
  // Multi-Worker & Quota Reset Integration
  // ==========================================
  it('Multi-Worker Concurrency: 20 CSV emails processed by 5 workers -> strictly 6 sent, 14 rescheduled', async () => {
    const senderId = `bulk_multi_worker_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const csvData = Array.from({ length: 20 }, (_, i) => `worker_lead_${i + 1}@corp.com`).join('\n');
    const recipients = parseCsvRecipients(csvData);

    const records = recipients.map((email, i) => ({
      recipient: email,
      subject: `Multi-Worker #${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: 6,
      delayBetweenEmails: 0.05,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    // 5 concurrent workers processing simultaneously
    const results = await Promise.all(
      created.map((item, idx) =>
        processEmail(item.id, senderId, 6, 0.05, `worker-${(idx % 5) + 1}`)
      )
    );

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 6, 'Strictly 6 sends authorized under multi-worker concurrency');
    assert.strictEqual(rescheduled, 14, 'Remaining 14 rescheduled to next window');
    assert.strictEqual(await getHourlyCount(senderId), 6, 'Redis counter strictly 6');
  });

  it('Prior Quota Consumed: When 14 sends exist, all 13 CSV emails are rescheduled with 0 sent', async () => {
    const senderId = `bulk_preconsumed_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    // Pre-populate counter to 14
    await setHourlyCount(senderId, 14);
    assert.strictEqual(await getHourlyCount(senderId), 14);

    const csvData = Array.from({ length: 13 }, (_, i) => `pre_${i + 1}@domain.io`).join('\n');
    const recipients = parseCsvRecipients(csvData);

    const records = recipients.map((email, i) => ({
      recipient: email,
      subject: `Preconsumed #${i + 1}`,
      body: 'Body',
      status: 'SCHEDULED' as const,
      scheduledAt: new Date(),
      hourlyLimit: 6,
      delayBetweenEmails: 0.1,
    }));

    const created = await prisma.emailJob.createManyAndReturn({ data: records, select: { id: true } });
    created.forEach((c) => createdJobIds.push(c.id));

    const results = [];
    for (const item of created) {
      results.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    const sent = results.filter((r) => r.status === 'SENT').length;
    const rescheduled = results.filter((r) => r.status === 'RATE_LIMITED').length;

    assert.strictEqual(sent, 0, '0 emails sent when prior quota already exceeded');
    assert.strictEqual(rescheduled, 13, 'All 13 rescheduled to next window');
    assert.strictEqual(await getHourlyCount(senderId), 14, 'Counter unincremented by rejections');

    // Quota reset simulation
    await resetSenderRateLimit(senderId);
    assert.strictEqual(await getHourlyCount(senderId), 0, 'Quota resets to 0');

    await prisma.emailJob.updateMany({
      where: { id: { in: created.map((c) => c.id) } },
      data: { scheduledAt: new Date(Date.now() - 1000) },
    });

    const secondPass = [];
    for (const item of created) {
      secondPass.push(await processEmail(item.id, senderId, 6, 0.1));
    }

    assert.strictEqual(secondPass.filter((r) => r.status === 'SENT').length, 6, 'Next window sends 6');
    assert.strictEqual(secondPass.filter((r) => r.status === 'RATE_LIMITED').length, 7, 'Remaining 7 rescheduled');
    assert.strictEqual(await getHourlyCount(senderId), 6);
  });
});
