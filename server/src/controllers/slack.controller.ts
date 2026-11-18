import { Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { prisma } from '../config/prisma.js';
import { redisConnection } from '../config/redis.js';
import { sendSlackRateLimitAlert } from '../services/slack.service.js';
import { encryptToken } from '../utils/encryption.js';

const STATE_TTL_SECONDS = 600; // 10 minutes

/**
 * Initiates the Slack OAuth v2 flow by generating a cryptographically secure
 * state parameter associated with the authenticated user in Redis.
 * GET /api/auth/slack/url
 */
export async function getSlackAuthUrl(req: Request, res: Response): Promise<void> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const redirectUri = process.env.SLACK_REDIRECT_URI || 'http://localhost:5000/api/auth/slack/callback';

  if (!clientId) {
    res.status(400).json({
      error: 'Slack Client ID not configured',
      message: 'Please set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in your .env, or use direct webhook connection.',
    });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'User must be authenticated to connect Slack' });
    return;
  }

  try {
    // Generate secure CSRF state
    const state = crypto.randomBytes(32).toString('hex');
    const stateKey = `slack:oauth:state:${state}`;

    // Store state in Redis with user binding and expiration
    await redisConnection.set(
      stateKey,
      JSON.stringify({ userId, createdAt: Date.now() }),
      'EX',
      STATE_TTL_SECONDS
    );

    // Slack OAuth v2 bot scopes: chat:write and incoming-webhook
    const scopes = ['chat:write', 'incoming-webhook', 'chat:write.public'].join(',');
    const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${encodeURIComponent(
      scopes
    )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    if (req.query.redirect === 'true') {
      res.redirect(authUrl);
    } else {
      res.json({ url: authUrl, state });
    }
  } catch (error: any) {
    console.error('❌ [Slack] Error generating OAuth URL:', error.message);
    res.status(500).json({ error: 'Failed to generate Slack OAuth URL', message: error.message });
  }
}

/**
 * Handles the OAuth v2 callback redirect from Slack.
 * Validates CSRF state against Redis, exchanges authorization code,
 * encrypts access token at rest (AES-256-GCM), and links to authenticated user.
 * GET /api/auth/slack/callback
 */
export async function handleSlackCallback(req: Request, res: Response): Promise<void> {
  const code = req.query.code as string;
  const state = req.query.state as string;
  const error = req.query.error as string;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redirectUri = process.env.SLACK_REDIRECT_URI || 'http://localhost:5000/api/auth/slack/callback';

  if (error) {
    console.warn(`⚠️ [Slack] User denied or cancelled Slack OAuth authorization: ${error}`);
    res.redirect(`${frontendUrl}?slack_connected=error&error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code || !state) {
    res.redirect(`${frontendUrl}?slack_connected=error&error=Missing_code_or_state_parameter`);
    return;
  }

  try {
    // 1. Validate CSRF state in Redis
    const stateKey = `slack:oauth:state:${state}`;
    const stateDataRaw = await redisConnection.get(stateKey);

    if (!stateDataRaw) {
      console.warn(`⚠️ [Slack] Invalid or expired OAuth state parameter: ${state}`);
      res.redirect(`${frontendUrl}?slack_connected=error&error=Invalid_or_expired_state`);
      return;
    }

    // Single-use: delete state immediately
    await redisConnection.del(stateKey);

    const { userId } = JSON.parse(stateDataRaw);
    if (!userId) {
      res.redirect(`${frontendUrl}?slack_connected=error&error=Missing_user_binding_in_state`);
      return;
    }

    // 2. Exchange authorization code with Slack OAuth v2 endpoint
    const params = new URLSearchParams();
    params.append('client_id', process.env.SLACK_CLIENT_ID || '');
    params.append('client_secret', process.env.SLACK_CLIENT_SECRET || '');
    params.append('code', code);
    params.append('redirect_uri', redirectUri);

    const response = await axios.post('https://slack.com/api/oauth.v2.access', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    const data = response.data;
    if (!data.ok) {
      console.error('❌ [Slack] OAuth token exchange error:', data.error);
      res.redirect(`${frontendUrl}?slack_connected=error&error=${encodeURIComponent(data.error || 'Token_exchange_failed')}`);
      return;
    }

    // 3. Encrypt sensitive tokens at rest using AES-256-GCM
    const rawAccessToken = data.access_token;
    const rawWebhookUrl = data.incoming_webhook?.url;

    const encryptedAccessToken = encryptToken(rawAccessToken);
    const encryptedWebhookUrl = rawWebhookUrl ? encryptToken(rawWebhookUrl) : null;

    const teamId = data.team?.id || null;
    const teamName = data.team?.name || 'Slack Workspace';
    const botUserId = data.bot_user_id || null;
    const channelId = data.incoming_webhook?.channel_id || null;
    const channelName = data.incoming_webhook?.channel || null;

    // 4. Upsert integration record scoped uniquely to this user/tenant
    await prisma.slackIntegration.upsert({
      where: { userId },
      update: {
        teamId,
        teamName,
        accessToken: encryptedAccessToken,
        botUserId,
        channelId,
        channelName,
        incomingWebhookUrl: encryptedWebhookUrl,
        isActive: true,
      },
      create: {
        userId,
        teamId,
        teamName,
        accessToken: encryptedAccessToken,
        botUserId,
        channelId,
        channelName,
        incomingWebhookUrl: encryptedWebhookUrl,
        isActive: true,
      },
    });

    console.log(`✅ [Slack] Workspace "${teamName}" connected successfully for user ${userId} (channel: ${channelName || 'N/A'})`);
    res.redirect(
      `${frontendUrl}?slack_connected=success&workspace=${encodeURIComponent(teamName)}&channel=${encodeURIComponent(
        channelName || ''
      )}`
    );
  } catch (error: any) {
    console.error('❌ [Slack] OAuth callback processing failed:', error.message);
    res.redirect(`${frontendUrl}?slack_connected=error&error=Server_error_during_token_exchange`);
  }
}

/**
 * Returns the current Slack connection status for the authenticated user.
 * GET /api/auth/slack/status
 */
export async function getSlackStatus(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const integration = await prisma.slackIntegration.findUnique({
      where: { userId },
    });

    if (!integration || !integration.isActive) {
      res.json({
        connected: false,
      });
      return;
    }

    // Return status WITHOUT exposing sensitive tokens to frontend
    res.json({
      connected: true,
      teamId: integration.teamId,
      teamName: integration.teamName || 'Workspace',
      channel: integration.channelName || '#general',
      connectedAt: integration.updatedAt,
    });
  } catch (error: any) {
    console.error('❌ [Slack] Error checking Slack status:', error.message);
    res.status(500).json({ error: 'Failed to check Slack status', message: error.message });
  }
}

/**
 * Connects Slack directly via Incoming Webhook URL scoped to the authenticated user.
 * POST /api/auth/slack/connect-webhook
 */
export async function connectSlackWebhook(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { webhookUrl, channelName } = req.body;

  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://hooks.slack.com')) {
    res.status(400).json({ error: 'Invalid Slack Webhook URL. It must start with https://hooks.slack.com' });
    return;
  }

  try {
    // Encrypt webhook URL at rest
    const encryptedWebhookUrl = encryptToken(webhookUrl);
    const encryptedPlaceholderToken = encryptToken('webhook_only_auth');

    await prisma.slackIntegration.upsert({
      where: { userId },
      update: {
        incomingWebhookUrl: encryptedWebhookUrl,
        channelName: channelName || '#notifications',
        accessToken: encryptedPlaceholderToken,
        isActive: true,
      },
      create: {
        userId,
        incomingWebhookUrl: encryptedWebhookUrl,
        channelName: channelName || '#notifications',
        accessToken: encryptedPlaceholderToken,
        isActive: true,
      },
    });

    res.json({
      success: true,
      message: 'Slack Webhook connected successfully',
      channel: channelName || '#notifications',
    });
  } catch (error: any) {
    console.error('❌ [Slack] Error connecting webhook:', error.message);
    res.status(500).json({ error: 'Failed to connect webhook', message: error.message });
  }
}

/**
 * Disconnects the authenticated user's Slack integration.
 * POST /api/auth/slack/disconnect
 */
export async function disconnectSlack(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await prisma.slackIntegration.updateMany({
      where: { userId },
      data: { isActive: false },
    });

    console.log(`🔌 [Slack] Integration disconnected for user ${userId}`);
    res.json({ success: true, message: 'Slack integration disconnected successfully' });
  } catch (error: any) {
    console.error('❌ [Slack] Error disconnecting Slack:', error.message);
    res.status(500).json({ error: 'Failed to disconnect Slack', message: error.message });
  }
}

/**
 * Sends a real test rate-limit alert to the authenticated user's connected Slack workspace.
 * POST /api/auth/slack/test
 */
export async function testSlackNotification(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const sent = await sendSlackRateLimitAlert({
      userId,
      senderEmail: 'test.sender@reachinbox.test',
      senderId: 'demo-sender',
      hourlyLimit: 200,
      currentCount: 201,
      nextHourTimestamp: new Date(Date.now() + 3600000),
      emailJobId: 'test-job-verification',
    });

    if (sent) {
      res.json({ success: true, message: 'Test Slack alert dispatched successfully!' });
    } else {
      res.status(400).json({
        success: false,
        message: 'No active Slack integration found for your account. Please connect Slack first.',
      });
    }
  } catch (error: any) {
    console.error('❌ [Slack] Error dispatching test alert:', error.message);
    res.status(500).json({ error: 'Failed to dispatch test notification', message: error.message });
  }
}
