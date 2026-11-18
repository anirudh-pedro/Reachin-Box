import { Redis, RedisOptions } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const isTest = process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('test'));

function buildRedisConfig(): { connectionUrl?: string; options: RedisOptions } {
  const redisUrl = process.env.REDIS_URL;
  const isTls = redisUrl?.startsWith('rediss://') || process.env.REDIS_TLS === 'true';

  let parsedHost = process.env.REDIS_HOST || '127.0.0.1';
  let parsedPort = parseInt(process.env.REDIS_PORT || '6379', 10);
  let parsedPassword = process.env.REDIS_PASSWORD || undefined;
  let parsedUsername: string | undefined = undefined;

  if (redisUrl) {
    try {
      const u = new URL(redisUrl);
      parsedHost = u.hostname;
      parsedPort = parseInt(u.port || (isTls ? '6380' : '6379'), 10);
      parsedUsername = u.username ? decodeURIComponent(u.username) : undefined;
      parsedPassword = u.password ? decodeURIComponent(u.password) : undefined;
    } catch {
      // If URL parsing fails, ioredis will parse connectionUrl string directly
    }
  }

  const options: RedisOptions = {
    host: parsedHost,
    port: parsedPort,
    username: parsedUsername,
    password: parsedPassword,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: isTest,
    ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
    retryStrategy(times) {
      if (process.env.REDIS_NO_RETRY === 'true') return null;
      if (isTest && times > 5) return null; // In tests, cap retries so test suite exits cleanly
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
  };

  return { connectionUrl: redisUrl, options };
}

const { connectionUrl, options } = buildRedisConfig();

export const redisConfig: RedisOptions = options;
export const redisConnection = connectionUrl
  ? new Redis(connectionUrl, options)
  : new Redis(options);

if (!isTest) {
  redisConnection.on('connect', () => {
    console.log('⚡ Connected to Redis successfully');
  });

  redisConnection.on('error', (err) => {
    console.error('❌ Redis Connection Error:', err.message);
  });
}
