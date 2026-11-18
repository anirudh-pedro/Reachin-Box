import { Router } from 'express';
import {
  getSlackAuthUrl,
  handleSlackCallback,
  connectSlackWebhook,
  getSlackStatus,
  disconnectSlack,
  testSlackNotification,
} from '../controllers/slack.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Public callback endpoint (receives browser redirect from Slack with code & state)
router.get('/callback', handleSlackCallback);

// Authenticated endpoints: require active ReachInbox user session
router.get('/url', requireAuth, getSlackAuthUrl);
router.get('/status', requireAuth, getSlackStatus);
router.post('/connect-webhook', requireAuth, connectSlackWebhook);
router.post('/disconnect', requireAuth, disconnectSlack);
router.post('/test', requireAuth, testSlackNotification);

export default router;
