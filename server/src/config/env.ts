import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform((val) => parseInt(val, 10)).default('5000'),
  HOST: z.string().default('0.0.0.0'),
  RUN_WORKER_IN_PROCESS: z.string().default('true'),
  ALLOWED_ORIGINS: z.string().optional(),
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform((val) => parseInt(val, 10)).default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // Elasticsearch
  ELASTICSEARCH_NODE: z.string().default('http://localhost:9200'),

  // Worker Settings
  WORKER_CONCURRENCY: z.string().transform((val) => parseInt(val, 10)).default('5'),
  DEFAULT_MIN_DELAY_SECONDS: z.string().transform((val) => parseInt(val, 10)).default('2'),
  DEFAULT_MAX_HOURLY_LIMIT: z.string().transform((val) => parseInt(val, 10)).default('200'),

  // Slack
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().default('http://localhost:5000/api/auth/slack/callback'),
  SLACK_TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // Google OAuth 2.0
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // JWT Session
  JWT_SECRET: z.string().default('reachinbox_default_jwt_secret_dev_32bytes_min!'),
  JWT_EXPIRES_IN: z.string().default('7d'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment validation failed:');
  console.error(parsed.error.flatten().fieldErrors);
}

export const env = parsed.success ? parsed.data : (process.env as any);

