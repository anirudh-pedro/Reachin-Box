import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Redis } from 'ioredis';
import { redisConnection } from '../../src/config/redis.js';
import {
  checkAndIncrementHourlyLimit,
  checkSenderDelayThrottle,
  resetSenderRateLimit,
} from '../../src/services/rate-limiter.service.js';

describe('Atomic Redis Lua Scripts - Real Redis Integration Tests', () => {
  let redis: Redis;

  before(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });

  after(async () => {
    await redis.quit();
  });

  it('atomically coordinates concurrent inter-send throttle reservations for the same sender', async () => {
    const senderId = `sender_throttle_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const minDelaySeconds = 2; // 2000 ms

    // Simulate 10 workers concurrently checking throttle at the exact same millisecond
    const promises = Array.from({ length: 10 }, () =>
      checkSenderDelayThrottle(senderId, minDelaySeconds)
    );

    const results = await Promise.all(promises);

    // Exactly ONE worker must be allowed immediately (waitMs = 0)
    const allowedImmediate = results.filter((r) => r.allowed === true);
    assert.strictEqual(allowedImmediate.length, 1, 'Exactly one worker should send immediately');
    assert.strictEqual(allowedImmediate[0].waitMs, 0);

    // The other 9 workers must be throttled with unique, strictly increasing future send slots
    const throttled = results.filter((r) => r.allowed === false);
    assert.strictEqual(throttled.length, 9, 'Remaining 9 workers must be throttled');

    // Sort by targetTimestamp to verify slot spacing
    throttled.sort((a, b) => a.targetTimestamp.getTime() - b.targetTimestamp.getTime());

    for (let i = 0; i < throttled.length - 1; i++) {
      const diff = throttled[i + 1].targetTimestamp.getTime() - throttled[i].targetTimestamp.getTime();
      // Each consecutive reserved slot should be separated by exactly 2000ms (minDelay)
      assert.strictEqual(diff, 2000, `Slot ${i + 1} and ${i} must be separated by 2000ms`);
    }

    await resetSenderRateLimit(senderId);
  });

  it('keeps inter-send throttling for independent senders completely isolated', async () => {
    const senderA = `sender_iso_a_${Date.now()}`;
    const senderB = `sender_iso_b_${Date.now()}`;

    await resetSenderRateLimit(senderA);
    await resetSenderRateLimit(senderB);

    // First send for sender A: allowed
    const rA1 = await checkSenderDelayThrottle(senderA, 2);
    assert.strictEqual(rA1.allowed, true);

    // Second send for sender A: throttled
    const rA2 = await checkSenderDelayThrottle(senderA, 2);
    assert.strictEqual(rA2.allowed, false);

    // First send for sender B: MUST BE ALLOWED (sender A throttle must not affect sender B!)
    const rB1 = await checkSenderDelayThrottle(senderB, 2);
    assert.strictEqual(rB1.allowed, true, 'Sender B must be allowed independently of Sender A');

    await resetSenderRateLimit(senderA);
    await resetSenderRateLimit(senderB);
  });

  it('atomically enforces hourly rate limits under heavy concurrent contention without exceeding limit', async () => {
    const senderId = `sender_hourly_${Date.now()}`;
    await resetSenderRateLimit(senderId);

    const hourlyLimit = 5;
    const concurrentRequests = 25;

    // Fire 25 concurrent check-and-increments simultaneously
    const results = await Promise.all(
      Array.from({ length: concurrentRequests }, () =>
        checkAndIncrementHourlyLimit(senderId, hourlyLimit)
      )
    );

    const allowed = results.filter((r) => r.allowed === true);
    const blocked = results.filter((r) => r.allowed === false);

    assert.strictEqual(allowed.length, 5, 'Exactly 5 calls must be allowed');
    assert.strictEqual(blocked.length, 20, '20 calls must be blocked');

    // Verify counter in Redis never exceeded the limit
    const lastAllowed = allowed[allowed.length - 1];
    assert.strictEqual(lastAllowed.currentCount, 5, 'Max counter in Redis must be exactly 5');

    // Verify Slack alert was flagged EXACTLY ONCE on the first breach
    const alertsFlagged = results.filter((r) => r.shouldAlert === true);
    assert.strictEqual(alertsFlagged.length, 1, 'Slack alert must be triggered exactly once per window');

    await resetSenderRateLimit(senderId);
  });
});
