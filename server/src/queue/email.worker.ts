import { Worker, Job } from 'bullmq';
import { redisConfig } from '../config/redis.js';
import { prisma } from '../config/prisma.js';
import { sendEmail } from '../services/mail.service.js';
import { EMAIL_QUEUE_NAME, EmailJobData, addEmailToQueue, emailQueue } from './email.queue.js';
import {
  checkAndIncrementHourlyLimit,
  checkSenderDelayThrottle,
  getNextHourStaggeredTimestamp,
  getHourlyCount,
  decrementHourlyLimit,
  rateLimitEvents,
} from '../services/rate-limiter.service.js';
import { indexEmail } from '../services/elasticsearch.service.js';
import { DistributedLock } from '../utils/distributed-lock.js';
import { Redis } from 'ioredis';

const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const MAX_ATTEMPTS = 3; // Keep in sync with emailQueue's defaultJobOptions.attempts in email.queue.ts
const workerRedis = new Redis(redisConfig);
const distributedLock = new DistributedLock(workerRedis);

export interface WorkerAuditLog {
  emailJobId: string;
  bullMqJobId: string;
  recipient: string;
  currentStatus: string;
  scheduledTime: string;
  actualWorkerExecutionTime: string;
  hourlyQuotaCount: number;
  hourlyLimit: number;
  rateLimitDecision: 'AUTHORIZED' | 'RATE_LIMITED' | 'SKIPPED' | 'THROTTLED';
  senderNextAvailableTime?: string | null;
  rescheduleReason?: string | null;
  nextExecutionTimestamp?: string | null;
}

export function logWorkerExecutionAudit(log: WorkerAuditLog): void {
  console.log(`\n📋 [WORKER_EXECUTION_AUDIT] ========================================`);
  console.log(`• Email ID:                    ${log.emailJobId}`);
  console.log(`• BullMQ Job ID:               ${log.bullMqJobId}`);
  console.log(`• Recipient:                   ${log.recipient}`);
  console.log(`• Current Status:              ${log.currentStatus}`);
  console.log(`• Scheduled Time:              ${log.scheduledTime}`);
  console.log(`• Actual Execution Time:       ${log.actualWorkerExecutionTime}`);
  console.log(`• Hourly Quota Count:          ${log.hourlyQuotaCount} / ${log.hourlyLimit}`);
  console.log(`• Rate Limit Decision:         ${log.rateLimitDecision}`);
  console.log(`• Sender Next Available Time:  ${log.senderNextAvailableTime || 'N/A'}`);
  console.log(`• Reschedule Reason:           ${log.rescheduleReason || 'None'}`);
  console.log(`• Next Execution Timestamp:    ${log.nextExecutionTimestamp || 'N/A'}`);
  console.log(`===================================================================\n`);
}

export const emailWorker = new Worker<EmailJobData>(
  EMAIL_QUEUE_NAME,
  async (job: Job<EmailJobData>) => {
    const { emailJobId, recipient, subject, body, senderId, userId, delayBetweenEmails, hourlyLimit } = job.data;
    console.log(`\n🚀 [Worker] Processing email job ${job.id} for ${recipient}...`);

    // 1. Idempotency Check in Database
    const emailRecord = await prisma.emailJob.findUnique({
      where: { id: emailJobId },
      include: { sender: true },
    });

    if (!emailRecord) {
      console.warn(`⚠️ [Worker] Email record ${emailJobId} not found in DB. Skipping.`);
      return { skipped: true, reason: 'Record not found' };
    }

    if (emailRecord.status === 'SENT') {
      console.log(`✨ [Worker] Email ${emailJobId} is already marked as SENT. Skipping.`);
      return { skipped: true, reason: 'Already sent' };
    }

    if (emailRecord.status === 'FAILED') {
      console.warn(`🛑 [Worker] Email ${emailJobId} is permanently marked as FAILED. Skipping.`);
      return { skipped: true, reason: 'Permanently failed' };
    }

    const nowMs = Date.now();
    // Stability Guard: If the email is already in RATE_LIMITED status and its scheduled window has not arrived yet, skip!
    // Prevents duplicate executions from repeatedly advancing timestamps or mutating the schedule.
    if (emailRecord.status === 'RATE_LIMITED' && emailRecord.scheduledAt.getTime() > nowMs + 500) {
      console.log(
        `⏳ [Worker] Email ${emailJobId} is already RATE_LIMITED and waiting for window at ${emailRecord.scheduledAt.toISOString()}. Skipping premature execution.`
      );
      logWorkerExecutionAudit({
        emailJobId,
        bullMqJobId: job.id!,
        recipient: emailRecord.recipient,
        currentStatus: 'RATE_LIMITED',
        scheduledTime: emailRecord.scheduledAt.toISOString(),
        actualWorkerExecutionTime: new Date().toISOString(),
        hourlyQuotaCount: await getHourlyCount(emailRecord.senderId || 'default'),
        hourlyLimit: emailRecord.hourlyLimit || 200,
        rateLimitDecision: 'SKIPPED',
        senderNextAvailableTime: emailRecord.scheduledAt.toISOString(),
        rescheduleReason: `Already scheduled for next window at ${emailRecord.scheduledAt.toISOString()}`,
        nextExecutionTimestamp: emailRecord.scheduledAt.toISOString(),
      });
      return { skipped: true, reason: 'Scheduled for future window' };
    }

    // Versioning Check: If the DB's active jobId belongs to a newer execution, verify existence
    if (emailRecord.jobId && emailRecord.jobId !== job.id) {
      const newerJob = await emailQueue.getJob(emailRecord.jobId);
      if (newerJob) {
        console.warn(
          `🔁 [Worker] Job ${job.id} has been superseded by active queue execution ${emailRecord.jobId}. Skipping.`
        );
        return { skipped: true, reason: 'Superseded by newer queue execution' };
      } else {
        // Crash recovery: DB references a new execution that failed to insert into Redis before crash
        console.warn(
          `🩹 [Worker Recovery] Email ${emailJobId} references execution ${emailRecord.jobId} missing from Redis. Re-enqueuing to recover.`
        );
        await addEmailToQueue(job.data, emailRecord.scheduledAt, emailRecord.jobId);
        return { recovered: true, newJobId: emailRecord.jobId };
      }
    }

    // Distributed Lock per logical EmailJob ID with auto-renewal heartbeat
    const lockKey = `lock:email:${emailJobId}`;
    const lockHandle = await distributedLock.acquire(lockKey, 60000, job.id);
    if (!lockHandle) {
      console.warn(`🔒 [Worker] Email ${emailJobId} is currently locked by another worker. Skipping duplicate execution.`);
      return { skipped: true, reason: 'Locked by concurrent worker' };
    }

    let hourlyQuotaConsumed = false;
    let currentSenderId = 'default';

    try {
      const effectiveSenderId = senderId || emailRecord.senderId || 'default';
      currentSenderId = effectiveSenderId;
      const effectiveHourlyLimit = hourlyLimit || emailRecord.hourlyLimit || emailRecord.sender?.hourlyLimit || 200;
      const effectiveDelaySeconds =
        delayBetweenEmails !== undefined
          ? delayBetweenEmails
          : emailRecord.delayBetweenEmails ?? emailRecord.sender?.delaySeconds ?? 2;

      // Helper to handle rescheduling when rate limit is exceeded
      const handleRateLimitExceeded = async (rlCheck: { currentCount: number; shouldAlert: boolean }) => {
        console.warn(
          `🚨 [Worker] Rate limit REACHED for sender ${effectiveSenderId} (${rlCheck.currentCount}/${effectiveHourlyLimit} this hour).`
        );

        // Staggered order-preserving schedule time in the next hour
        const nextHourTimestamp = await getNextHourStaggeredTimestamp(effectiveSenderId, effectiveDelaySeconds);
        const nextRescheduleCount = (job.data.rescheduleCount || 0) + 1;
        const newQueueJobId = `${emailJobId}:rate_limit:${nextRescheduleCount}`;

        console.log(
          `⏳ Rescheduling email ${emailJobId} to next window at ${nextHourTimestamp.toISOString()} with new jobId: ${newQueueJobId}`
        );

        // Update DB to RATE_LIMITED status with new scheduledAt timestamp and new queue jobId
        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'RATE_LIMITED',
            scheduledAt: nextHourTimestamp,
            jobId: newQueueJobId,
          },
        });

        // Update in Elasticsearch
        indexEmail({
          id: emailJobId,
          recipient,
          subject,
          body,
          status: 'RATE_LIMITED',
          senderEmail: emailRecord.sender?.email,
          scheduledAt: nextHourTimestamp,
          createdAt: emailRecord.createdAt,
        }).catch((e) => console.warn('ES indexing warning:', e.message));

        // Emit Slack alert ONLY on the first time the limit was tripped in this window
        if (rlCheck.shouldAlert) {
          console.log(`🔔 [Worker] Triggering Slack rate-limit alert for sender ${effectiveSenderId}...`);
          rateLimitEvents.emit('RATE_LIMIT_TRIPPED', {
            senderId: effectiveSenderId,
            senderEmail: emailRecord.sender?.email || 'default@reachinbox.test',
            userId: userId || emailRecord.userId,
            hourlyLimit: effectiveHourlyLimit,
            currentCount: rlCheck.currentCount,
            emailJobId,
            nextHourTimestamp,
          });
        } else {
          console.log(`ℹ️ [Worker] Rate limit alert already sent for sender ${effectiveSenderId} in this window.`);
        }

        // Reschedule into next window with new deterministic execution ID (NEVER DROPPED)
        await addEmailToQueue(
          { ...job.data, rescheduleCount: nextRescheduleCount },
          nextHourTimestamp,
          newQueueJobId
        );

        logWorkerExecutionAudit({
          emailJobId,
          bullMqJobId: job.id!,
          recipient,
          currentStatus: 'RATE_LIMITED',
          scheduledTime: emailRecord.scheduledAt.toISOString(),
          actualWorkerExecutionTime: new Date().toISOString(),
          hourlyQuotaCount: rlCheck.currentCount,
          hourlyLimit: effectiveHourlyLimit,
          rateLimitDecision: 'RATE_LIMITED',
          senderNextAvailableTime: nextHourTimestamp.toISOString(),
          rescheduleReason: `Hourly sending quota reached (${rlCheck.currentCount}/${effectiveHourlyLimit}). Rescheduled to next window.`,
          nextExecutionTimestamp: nextHourTimestamp.toISOString(),
        });

        return {
          rateLimited: true,
          rescheduledTo: nextHourTimestamp,
          newJobId: newQueueJobId,
          message: 'Rate limit reached. Rescheduled to next hour window.',
        };
      };

      // 1. Fast-path check: Is the hourly limit already full before reserving a delay slot?
      const currentHourlyCount = await getHourlyCount(effectiveSenderId);
      if (currentHourlyCount >= effectiveHourlyLimit) {
        // Hourly limit is already exhausted: record alert via atomic check and reschedule
        const rateLimitCheck = await checkAndIncrementHourlyLimit(effectiveSenderId, effectiveHourlyLimit);
        return await handleRateLimitExceeded(rateLimitCheck);
      }

      // 2. Atomic Per-Sender Inter-Send Delay Throttle
      const throttleCheck = await checkSenderDelayThrottle(effectiveSenderId, effectiveDelaySeconds);
      if (!throttleCheck.allowed) {
        if (throttleCheck.waitMs <= 10000) {
          // In-process pacing: wait for the reserved slot without touching DB or BullMQ
          console.log(
            `⏱️ [Worker] Inter-send pacing for sender ${effectiveSenderId}: waiting ${throttleCheck.waitMs}ms until reserved slot...`
          );
          await new Promise((resolve) => setTimeout(resolve, throttleCheck.waitMs));
        } else {
          // Large wait (> 10s): only reschedule via BullMQ if wait exceeds in-process threshold
          const nextRescheduleCount = (job.data.rescheduleCount || 0) + 1;
          const newQueueJobId = `${emailJobId}:throttle:${nextRescheduleCount}`;

          console.log(
            `⏱️ [Worker] Extended inter-send throttle: spacing sender ${effectiveSenderId} by ${throttleCheck.waitMs}ms. Rescheduling via BullMQ (new jobId: ${newQueueJobId}).`
          );

          // DO NOT overwrite scheduledAt in DB - preserve user's original schedule time
          await prisma.emailJob.update({
            where: { id: emailJobId },
            data: {
              jobId: newQueueJobId,
            },
          });

          await addEmailToQueue(
            { ...job.data, rescheduleCount: nextRescheduleCount },
            throttleCheck.targetTimestamp,
            newQueueJobId
          );

          logWorkerExecutionAudit({
            emailJobId,
            bullMqJobId: job.id!,
            recipient,
            currentStatus: 'THROTTLED',
            scheduledTime: emailRecord.scheduledAt.toISOString(),
            actualWorkerExecutionTime: new Date().toISOString(),
            hourlyQuotaCount: currentHourlyCount,
            hourlyLimit: effectiveHourlyLimit,
            rateLimitDecision: 'THROTTLED',
            senderNextAvailableTime: throttleCheck.targetTimestamp.toISOString(),
            rescheduleReason: `Inter-send pacing wait exceeded 10s (${throttleCheck.waitMs}ms). Delayed via BullMQ.`,
            nextExecutionTimestamp: throttleCheck.targetTimestamp.toISOString(),
          });

          return {
            throttled: true,
            rescheduledTo: throttleCheck.targetTimestamp,
            newJobId: newQueueJobId,
          };
        }
      }

      // 3. Atomic Hourly Rate Limit Authorization via Redis Lua
      const rateLimitCheck = await checkAndIncrementHourlyLimit(effectiveSenderId, effectiveHourlyLimit);
      if (!rateLimitCheck.allowed) {
        return await handleRateLimitExceeded(rateLimitCheck);
      }

      // Mark that a quota slot has been atomically reserved
      hourlyQuotaConsumed = true;

      // 4. Update status to PROCESSING atomically
      await prisma.emailJob.updateMany({
        where: {
          id: emailJobId,
          status: { in: ['SCHEDULED', 'RATE_LIMITED', 'PROCESSING'] },
        },
        data: { status: 'PROCESSING' },
      });

      // 5. Send via Ethereal SMTP
      const result = await sendEmail({
        to: recipient,
        subject,
        body,
        senderId: effectiveSenderId !== 'default' ? effectiveSenderId : undefined,
      });

      // 6. Mark as SENT in DB
      const updated = await prisma.emailJob.update({
        where: { id: emailJobId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          etherealPreviewUrl: result.previewUrl || null,
          etherealMessageId: result.messageId,
          error: null,
        },
      });

      // 7. Update document in Elasticsearch
      indexEmail({
        id: emailJobId,
        recipient,
        subject,
        body,
        status: 'SENT',
        senderEmail: result.senderEmail,
        scheduledAt: updated.scheduledAt,
        sentAt: updated.sentAt,
        etherealPreviewUrl: result.previewUrl || null,
        createdAt: updated.createdAt,
      }).catch((e) => console.warn('ES indexing warning:', e.message));

      console.log(`✅ [Worker] Email ${emailJobId} successfully SENT!`);
      if (result.previewUrl) {
        console.log(`🔗 [Worker] Ethereal Preview URL: ${result.previewUrl}`);
      }

      logWorkerExecutionAudit({
        emailJobId,
        bullMqJobId: job.id!,
        recipient,
        currentStatus: 'SENT',
        scheduledTime: emailRecord.scheduledAt.toISOString(),
        actualWorkerExecutionTime: new Date().toISOString(),
        hourlyQuotaCount: rateLimitCheck.currentCount,
        hourlyLimit: effectiveHourlyLimit,
        rateLimitDecision: 'AUTHORIZED',
        senderNextAvailableTime: throttleCheck.targetTimestamp.toISOString(),
        rescheduleReason: null,
        nextExecutionTimestamp: null,
      });

      return {
        success: true,
        emailJobId: updated.id,
        previewUrl: result.previewUrl,
        sentAt: updated.sentAt,
      };
    } catch (err: any) {
      if (hourlyQuotaConsumed) {
        try {
          await decrementHourlyLimit(currentSenderId);
          console.log(`↩️ [Worker] Refunded hourly rate limit slot for sender ${currentSenderId} after send failure.`);
        } catch (decrErr: any) {
          console.warn(`Failed to refund hourly rate limit for sender ${currentSenderId}:`, decrErr.message);
        }
      }

      const currentAttemptNumber = job.attemptsMade + 1;
      const isInfrastructureError =
        err.message?.includes('Connection is closed') ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('Rate limiter service error') ||
        err.message?.includes('ClusterAllFailedError') ||
        err.message?.includes('connect ECONNREFUSED');

      const isFinalAttempt = !isInfrastructureError && currentAttemptNumber >= MAX_ATTEMPTS;

      console.error(
        `❌ [Worker] Failed to process email ${emailJobId} (attempt ${currentAttemptNumber}/${MAX_ATTEMPTS}, infra=${isInfrastructureError}):`,
        err.message
      );

      if (isFinalAttempt) {
        console.error(`💀 [Worker] Email ${emailJobId} has exhausted all ${MAX_ATTEMPTS} attempts. Marking FAILED.`);

        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'FAILED',
            error: err.message,
            attempts: { increment: 1 },
          },
        }).catch((e) => console.warn('DB update warning during final failure:', e.message));

        indexEmail({
          id: emailJobId,
          recipient,
          subject,
          body,
          status: 'FAILED',
          scheduledAt: emailRecord.scheduledAt,
          createdAt: emailRecord.createdAt,
        }).catch((e) => console.warn('ES indexing warning:', e.message));
      } else {
        console.warn(
          `🔁 [Worker] Email ${emailJobId} will be retried by BullMQ (attempt ${currentAttemptNumber} failed${isInfrastructureError ? ' due to transient infrastructure outage' : ''}).`
        );

        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            error: err.message,
            attempts: { increment: 1 },
          },
        }).catch((e) => console.warn('DB update warning during attempt record:', e.message));
      }

      throw err;
    } finally {
      // Safely release distributed lock verifying token ownership
      try {
        if (lockHandle) {
          await lockHandle.release();
        }
      } catch (e: any) {
        console.warn(`⚠️ [Worker] Failed to release lock ${lockKey}:`, e.message);
      }
    }
  },
  {
    connection: workerRedis,
    concurrency,
  }
);

console.log(`👷 [Worker] Email worker started | queue: "${EMAIL_QUEUE_NAME}" | concurrency: ${concurrency}`);

emailWorker.on('completed', (job) => {
  console.log(`🎉 Job ${job.id} has completed successfully.`);
});

emailWorker.on('failed', (job, err) => {
  console.error(`💥 Job ${job?.id} failed with error:`, err.message);
});

emailWorker.on('error', (err) => {
  console.error('💥 Worker internal error:', err.message);
});
