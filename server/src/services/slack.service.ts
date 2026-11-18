import axios from 'axios';
import { prisma } from '../config/prisma.js';
import { rateLimitEvents } from './rate-limiter.service.js';
import { decryptToken } from '../utils/encryption.js';

export interface SlackAlertParams {
  senderEmail: string;
  senderId: string;
  userId?: string;
  hourlyLimit: number;
  currentCount: number;
  nextHourTimestamp: Date;
  emailJobId: string;
}

/**
 * Builds rich Slack blocks for rate-limit notifications.
 */
function buildSlackBlocks(params: {
  senderEmail: string;
  hourlyLimit: number;
  currentCount: number;
  resumeTimeStr: string;
}) {
  const { senderEmail, hourlyLimit, currentCount, resumeTimeStr } = params;

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🚨 Sender Hourly Limit Exceeded',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Sender Account:*\n\`${senderEmail}\``,
        },
        {
          type: 'mrkdwn',
          text: `*Hourly Quota:*\n${currentCount} / ${hourlyLimit} emails`,
        },
        {
          type: 'mrkdwn',
          text: `*Action Taken:*\nDelayed & Rescheduled`,
        },
        {
          type: 'mrkdwn',
          text: `*Next Send Window:*\n${resumeTimeStr}`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '🛡️ *ReachInbox Zero-Drop Engine:* No emails were dropped. Remaining campaign leads are safely delayed and will automatically resume.',
        },
      ],
    },
  ];
}

/**
 * Dispatches a real rate-limit notification to the user's connected Slack workspace.
 * Resolves the tenant's integration, decrypts the stored token at runtime,
 * and sends via Slack Web API (chat.postMessage) or Incoming Webhook.
 */
export async function sendSlackRateLimitAlert(params: SlackAlertParams): Promise<boolean> {
  const { senderEmail, hourlyLimit, currentCount, nextHourTimestamp, userId } = params;

  if (!userId) {
    console.log(`ℹ️ [Slack] No userId associated with rate-limit event for sender ${senderEmail}. Alert skipped.`);
    return false;
  }

  try {
    // 1. Find active Slack integration for this specific user/tenant
    const integration = await prisma.slackIntegration.findUnique({
      where: { userId },
    });

    if (!integration || !integration.isActive) {
      console.log(`ℹ️ [Slack] User ${userId} has no active Slack integration. Rate limit event skipped (graceful no-op).`);
      return false;
    }

    const resumeTimeStr = nextHourTimestamp.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });

    const textFallback = `🚨 *ReachInbox Rate Limit Alert:* Sender \`${senderEmail}\` has exceeded the hourly send limit (${currentCount}/${hourlyLimit}). Emails have been safely rescheduled into the next window (${resumeTimeStr}).`;
    const blocks = buildSlackBlocks({
      senderEmail,
      hourlyLimit,
      currentCount,
      resumeTimeStr,
    });

    // 2. Dispatch via Incoming Webhook if available
    if (integration.incomingWebhookUrl) {
      try {
        const decryptedWebhookUrl = decryptToken(integration.incomingWebhookUrl);
        await axios.post(
          decryptedWebhookUrl,
          { text: textFallback, blocks },
          { timeout: 5000 }
        );
        console.log(`🔔 [Slack] Rate limit alert dispatched via Webhook for user ${userId} (channel: ${integration.channelName || 'default'})`);
        return true;
      } catch (err: any) {
        console.error(`❌ [Slack] Webhook delivery failed for user ${userId}:`, err.message);
        // Fall through to try Web API if access token also exists
      }
    }

    // 3. Dispatch via Slack Web API (chat.postMessage)
    if (integration.accessToken) {
      try {
        const decryptedToken = decryptToken(integration.accessToken);

        // If decryptedToken is placeholder for webhook-only auth, skip Web API
        if (decryptedToken === 'webhook_only_auth') {
          return false;
        }

        const targetChannel = integration.channelId || integration.channelName || '#general';
        const response = await axios.post(
          'https://slack.com/api/chat.postMessage',
          {
            channel: targetChannel,
            text: textFallback,
            blocks,
          },
          {
            headers: {
              Authorization: `Bearer ${decryptedToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 5000,
          }
        );

        if (!response.data.ok) {
          console.error(`❌ [Slack] chat.postMessage API error for user ${userId}:`, response.data.error);
          return false;
        }

        console.log(`🔔 [Slack] Rate limit alert dispatched via Web API to workspace "${integration.teamName || 'Slack'}" (channel: ${targetChannel})`);
        return true;
      } catch (err: any) {
        console.error(`❌ [Slack] Web API delivery failed for user ${userId}:`, err.message);
        return false;
      }
    }

    return false;
  } catch (err: any) {
    console.error(`❌ [Slack] Unexpected error in sendSlackRateLimitAlert for user ${userId}:`, err.message);
    return false;
  }
}

// Hook into BullMQ worker rate limit event emitter
rateLimitEvents.on('RATE_LIMIT_TRIPPED', (data: SlackAlertParams) => {
  console.log(`⚡ [Slack Listener] RATE_LIMIT_TRIPPED received for sender "${data.senderEmail}" (user: ${data.userId || 'none'})`);
  sendSlackRateLimitAlert(data).catch((err) => {
    console.error('❌ [Slack Listener] Unhandled error in listener callback:', err.message);
  });
});
