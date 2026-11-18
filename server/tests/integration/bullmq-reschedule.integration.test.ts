import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { emailQueue, addEmailToQueue } from '../../src/queue/email.queue.js';
import { redisConnection } from '../../src/config/redis.js';
import { prisma } from '../../src/config/prisma.js';

describe('BullMQ Rescheduling & Crash Recovery - Real Queue Integration Tests', () => {
  const createdJobIds: string[] = [];

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    if (createdJobIds.length > 0) {
      await prisma.emailJob.deleteMany({
        where: { id: { in: createdJobIds } },
      });
    }
    await emailQueue.drain();
    await prisma.$disconnect();
  });

  it('proves that versioned execution IDs allow reliable delayed rescheduling without active-job collision', async () => {
    // 1. Create DB record
    const emailRecord = await prisma.emailJob.create({
      data: {
        recipient: 'reschedule.test@outreach.io',
        subject: 'Reschedule Collision Test',
        body: 'Verifying BullMQ delayed execution',
        status: 'SCHEDULED',
        scheduledAt: new Date(Date.now() + 60000),
      },
    });
    createdJobIds.push(emailRecord.id);

    // Initial enqueue with deterministic jobId = emailRecord.id
    const initialJobId = await addEmailToQueue(
      {
        emailJobId: emailRecord.id,
        recipient: emailRecord.recipient,
        subject: emailRecord.subject,
        body: emailRecord.body,
        rescheduleCount: 0,
      },
      new Date(Date.now() + 60000),
      emailRecord.id
    );

    assert.strictEqual(initialJobId, emailRecord.id);

    const initialQueueJob = await emailQueue.getJob(initialJobId);
    assert.ok(initialQueueJob !== null);
    assert.strictEqual(await initialQueueJob.getState(), 'delayed');

    // 2. Rescheduling with versioned execution ID: `${emailRecord.id}:rate_limit:1`
    const rescheduledJobId = `${emailRecord.id}:rate_limit:1`;
    const targetTimestamp = new Date(Date.now() + 120000);

    const newJobId = await addEmailToQueue(
      {
        emailJobId: emailRecord.id,
        recipient: emailRecord.recipient,
        subject: emailRecord.subject,
        body: emailRecord.body,
        rescheduleCount: 1,
      },
      targetTimestamp,
      rescheduledJobId
    );

    assert.strictEqual(newJobId, rescheduledJobId);

    // Verify the new delayed job exists in Redis independently
    const rescheduledQueueJob = await emailQueue.getJob(rescheduledJobId);
    assert.ok(rescheduledQueueJob !== null, 'Rescheduled versioned job must exist in BullMQ');
    assert.strictEqual(await rescheduledQueueJob.getState(), 'delayed');

    // Verify DB record now points to the active rescheduled execution ID
    const updatedRecord = await prisma.emailJob.findUnique({
      where: { id: emailRecord.id },
    });
    assert.strictEqual(updatedRecord?.jobId, rescheduledJobId);
  });
});
