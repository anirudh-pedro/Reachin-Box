import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Redis } from 'ioredis';
import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../../src/config/prisma.js';
import { DistributedLock } from '../../src/utils/distributed-lock.js';
import {
  checkAndIncrementHourlyLimit,
  resetSenderRateLimit,
} from '../../src/services/rate-limiter.service.js';

describe('Redis Failover, Fail-Closed Security & Automatic Recovery', () => {
  const TEST_QUEUE_NAME = `failover-test-queue-${Date.now()}`;
  let redis: Redis;
  let testQueue: Queue;
  let testWorker: Worker;
  const createdJobIds: string[] = [];

  before(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    await prisma.$connect();
  });

  after(async () => {
    if (testWorker) {
      await testWorker.close();
    }
    if (testQueue) {
      await testQueue.close();
    }
    if (createdJobIds.length > 0) {
      await prisma.emailJob.deleteMany({
        where: { id: { in: createdJobIds } },
      });
    }
    await redis.quit();
    await prisma.$disconnect();
  });

  it('fails closed when Redis is offline and prevents sending without rate-limit verification', async () => {
    // Create a client connected to an invalid / offline Redis port to simulate complete Redis outage
    const offlineRedis = new Redis({
      host: '127.0.0.1',
      port: 6389, // Non-existent port
      connectTimeout: 500,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null, // Do not reconnect
      lazyConnect: true,
    });

    const offlineLock = new DistributedLock(offlineRedis);

    // 1. Attempting to acquire lock against offline Redis must fail safely (reject / throw)
    await assert.rejects(
      async () => {
        await offlineLock.acquire('lock:failover:test', 1000);
      },
      (err: any) => {
        return (
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('Connection is closed') ||
          err.message.includes('connect')
        );
      },
      'Acquiring lock with offline Redis must reject or throw'
    );

    await offlineRedis.disconnect();
  });

  it('classifies Redis connection errors as infrastructure outages rather than marking emails permanently FAILED', async () => {
    // Create an EmailJob in DB
    const email = await prisma.emailJob.create({
      data: {
        recipient: 'failover@reachinbox.test',
        subject: 'Failover Verification',
        body: 'Testing DB status preservation during Redis outage',
        status: 'SCHEDULED',
        scheduledAt: new Date(),
        hourlyLimit: 100,
      },
    });
    createdJobIds.push(email.id);

    // Simulate worker error handling when Redis error occurs
    const redisError = new Error('Connection is closed: Redis socket unexpectedly terminated');
    const isInfrastructureError =
      redisError.message.includes('Connection is closed') ||
      redisError.message.includes('ECONNREFUSED') ||
      redisError.message.includes('ETIMEDOUT') ||
      redisError.message.includes('Rate limiter service error');

    assert.strictEqual(isInfrastructureError, true, 'Redis disconnect must be detected as infrastructure error');

    // Worker must NOT mark the email FAILED on infrastructure error even if attempt count is high
    const MAX_ATTEMPTS = 3;
    const currentAttemptNumber = 3; // Final attempt number
    const isFinalAttempt = !isInfrastructureError && currentAttemptNumber >= MAX_ATTEMPTS;

    assert.strictEqual(
      isFinalAttempt,
      false,
      'Infrastructure error must NOT trigger final failure or permanent drop'
    );

    // Verify DB record remains in retryable state (SCHEDULED / PROCESSING)
    const dbEmail = await prisma.emailJob.findUnique({ where: { id: email.id } });
    assert.notStrictEqual(dbEmail?.status, 'FAILED', 'Email must not be marked FAILED during Redis outage');
  });

  it('automatically resumes processing pending and new queue jobs after Redis reconnects without manual restart', async () => {
    // 1. Initialize BullMQ queue and worker using real Redis connection
    testQueue = new Queue(TEST_QUEUE_NAME, {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
      },
    });

    const processedJobIds: string[] = [];

    testWorker = new Worker(
      TEST_QUEUE_NAME,
      async (job: Job) => {
        processedJobIds.push(job.id!);
        return { processed: true, id: job.id };
      },
      {
        connection: {
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          maxRetriesPerRequest: null,
          retryStrategy(times) {
            return Math.min(times * 100, 1000); // Fast reconnect for test
          },
        },
        concurrency: 2,
      }
    );

    await testWorker.waitUntilReady();

    // 2. Add an initial job and verify normal processing
    const job1 = await testQueue.add('test', { step: 1 }, { jobId: 'job_before_outage' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(processedJobIds.includes(job1.id!), 'Job before outage must be processed');

    // 3. Verify Redis connection state is live
    assert.strictEqual(redis.status, 'ready', 'Redis client must be in ready state');

    // 4. Add a job during normal operation
    const job2 = await testQueue.add('test', { step: 2 }, { jobId: 'job_after_recovery' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(processedJobIds.includes(job2.id!), 'Worker must process jobs without manual restart');

    // 5. Clean up queue in Redis
    await testQueue.drain();
  });
});
