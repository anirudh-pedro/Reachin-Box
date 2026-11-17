import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Redis } from 'ioredis';
import { DistributedLock } from '../../src/utils/distributed-lock.js';

describe('DistributedLock - Real Redis Integration Tests', () => {
  let redis: Redis;
  let lock: DistributedLock;

  before(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    lock = new DistributedLock(redis);
  });

  after(async () => {
    await redis.quit();
  });

  it('atomically acquires an exclusive lock and blocks concurrent acquisition', async () => {
    const lockKey = `test:lock:${Date.now()}`;

    // Worker 1 acquires lock
    const handle1 = await lock.acquire(lockKey, 5000, 'worker_1_token');
    assert.ok(handle1 !== null, 'Worker 1 should acquire lock');
    assert.strictEqual(handle1.token, 'worker_1_token');

    // Worker 2 attempts to acquire same lock
    const handle2 = await lock.acquire(lockKey, 5000, 'worker_2_token');
    assert.strictEqual(handle2, null, 'Worker 2 should be rejected while Worker 1 holds lock');

    // Worker 1 releases
    const released = await handle1.release();
    assert.strictEqual(released, true, 'Worker 1 should release lock');

    // Now Worker 2 can acquire
    const handle3 = await lock.acquire(lockKey, 5000, 'worker_3_token');
    assert.ok(handle3 !== null, 'Worker 3 should acquire after release');
    await handle3.release();
  });

  it('safely prevents releasing a lock owned by another token', async () => {
    const lockKey = `test:lock:safety:${Date.now()}`;

    // Worker 1 acquires
    const handle1 = await lock.acquire(lockKey, 5000, 'token_real_owner');
    assert.ok(handle1 !== null);

    // Attacker or stale worker attempts to release with wrong token
    const wrongRelease = await lock.release(lockKey, 'token_wrong_attacker');
    assert.strictEqual(wrongRelease, false, 'Release with wrong token must fail');

    // Lock must still be held by real owner
    const valInRedis = await redis.get(lockKey);
    assert.strictEqual(valInRedis, 'token_real_owner', 'Lock must still be held by original owner');

    // Clean up
    await handle1.release();
  });

  it('auto-renews lock via heartbeat during long execution', async () => {
    const lockKey = `test:lock:heartbeat:${Date.now()}`;

    // Acquire lock with short TTL (1500ms)
    const handle = await lock.acquire(lockKey, 1500, 'worker_heartbeat_token');
    assert.ok(handle !== null);

    // Wait 2200ms (longer than the initial 1500ms TTL)
    // The heartbeat interval (1500/3 = 500ms) will have renewed the lock
    await new Promise((r) => setTimeout(r, 2200));

    // Lock should STILL be active in Redis due to heartbeat renewal!
    const val = await redis.get(lockKey);
    assert.strictEqual(val, 'worker_heartbeat_token', 'Lock must still exist after initial TTL expired due to heartbeat');

    await handle.release();

    // After release, key must be gone
    const afterReleaseVal = await redis.get(lockKey);
    assert.strictEqual(afterReleaseVal, null);
  });
});
