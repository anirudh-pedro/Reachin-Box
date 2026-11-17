import { Redis } from 'ioredis';
import crypto from 'crypto';

const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

const RENEW_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface LockHandle {
  lockKey: string;
  token: string;
  release: () => Promise<boolean>;
  extend: (extraTtlMs?: number) => Promise<boolean>;
}

export class DistributedLock {
  private redis: Redis;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
  }

  /**
   * Attempts to acquire an exclusive lock with auto-renewal heartbeat.
   * If acquired, starts a background heartbeat interval that keeps the lock alive
   * during long-running operations until release() is called.
   */
  async acquire(
    lockKey: string,
    ttlMs: number = 60000,
    customToken?: string
  ): Promise<LockHandle | null> {
    const token = customToken || `${process.pid}_${Date.now()}_${crypto.randomUUID()}`;

    // Atomic acquisition via SET NX PX
    const result = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') {
      return null;
    }

    let isReleased = false;

    // Heartbeat: renew lock at 1/3 of TTL interval
    const heartbeatIntervalMs = Math.max(1000, Math.floor(ttlMs / 3));
    const heartbeatTimer = setInterval(async () => {
      if (isReleased) {
        clearInterval(heartbeatTimer);
        return;
      }
      try {
        await this.renew(lockKey, token, ttlMs);
      } catch (err: any) {
        console.warn(`⚠️ [Lock] Heartbeat renewal failed for ${lockKey}:`, err.message);
      }
    }, heartbeatIntervalMs);

    // Unref so heartbeat doesn't prevent Node process exit
    if (heartbeatTimer.unref) {
      heartbeatTimer.unref();
    }

    const release = async (): Promise<boolean> => {
      if (isReleased) return true;
      isReleased = true;
      clearInterval(heartbeatTimer);
      return this.release(lockKey, token);
    };

    const extend = async (extraTtlMs: number = ttlMs): Promise<boolean> => {
      if (isReleased) return false;
      return this.renew(lockKey, token, extraTtlMs);
    };

    return {
      lockKey,
      token,
      release,
      extend,
    };
  }

  /**
   * Safely releases the lock ONLY if the token still matches ownership.
   */
  async release(lockKey: string, token: string): Promise<boolean> {
    try {
      const res = (await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token)) as number;
      return res === 1;
    } catch (err: any) {
      console.warn(`⚠️ [Lock] Error releasing lock ${lockKey}:`, err.message);
      return false;
    }
  }

  /**
   * Renews lock expiration ONLY if the token still matches ownership.
   */
  async renew(lockKey: string, token: string, ttlMs: number): Promise<boolean> {
    try {
      const res = (await this.redis.eval(RENEW_LOCK_LUA, 1, lockKey, token, ttlMs.toString())) as number;
      return res === 1;
    } catch (err: any) {
      console.warn(`⚠️ [Lock] Error renewing lock ${lockKey}:`, err.message);
      return false;
    }
  }
}
