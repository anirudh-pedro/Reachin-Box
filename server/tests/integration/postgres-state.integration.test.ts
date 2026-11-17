import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '../../src/config/prisma.js';

describe('PostgreSQL State Transitions & Idempotency - Real Database Integration Tests', () => {
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
    await prisma.$disconnect();
  });

  it('guarantees that only ONE worker can transition a job to PROCESSING concurrently', async () => {
    // Create a new job in SCHEDULED status
    const job = await prisma.emailJob.create({
      data: {
        recipient: 'test.race@example.com',
        subject: 'Concurrency Test',
        body: 'Testing atomic status transition',
        status: 'SCHEDULED',
        scheduledAt: new Date(),
        delayBetweenEmails: 2,
        hourlyLimit: 200,
      },
    });
    createdJobIds.push(job.id);

    // 5 concurrent workers attempt to transition the same job to PROCESSING simultaneously
    const attempts = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const updateResult = await prisma.emailJob.updateMany({
          where: {
            id: job.id,
            status: { in: ['SCHEDULED', 'RATE_LIMITED'] },
          },
          data: {
            status: 'PROCESSING',
          },
        });
        return updateResult.count; // 1 if won transition, 0 if lost
      })
    );

    const winners = attempts.filter((count) => count === 1);
    const losers = attempts.filter((count) => count === 0);

    assert.strictEqual(winners.length, 1, 'Exactly one worker must win the state transition');
    assert.strictEqual(losers.length, 4, 'Remaining 4 workers must see status is no longer SCHEDULED');

    // Verify database row status is PROCESSING
    const checkDb = await prisma.emailJob.findUnique({ where: { id: job.id } });
    assert.strictEqual(checkDb?.status, 'PROCESSING');
  });

  it('protects SENT status from being overwritten or re-processed', async () => {
    const job = await prisma.emailJob.create({
      data: {
        recipient: 'test.sent@example.com',
        subject: 'Idempotency Test',
        body: 'Already sent email',
        status: 'SENT',
        sentAt: new Date(),
        scheduledAt: new Date(),
        etherealPreviewUrl: 'https://ethereal.email/message/test123',
      },
    });
    createdJobIds.push(job.id);

    // Stale worker or duplicate delivery attempts conditional update
    const staleAttempt = await prisma.emailJob.updateMany({
      where: {
        id: job.id,
        status: { in: ['SCHEDULED', 'RATE_LIMITED'] },
      },
      data: {
        status: 'PROCESSING',
      },
    });

    assert.strictEqual(staleAttempt.count, 0, 'Cannot transition already-SENT email to PROCESSING');

    const checkDb = await prisma.emailJob.findUnique({ where: { id: job.id } });
    assert.strictEqual(checkDb?.status, 'SENT', 'Status must remain SENT');
  });
});
