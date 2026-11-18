import { Router } from 'express';
import {
  scheduleEmails,
  getScheduledEmails,
  getSentEmails,
  searchEmailsHandler,
  getStats,
  getSenders,
  getEmailById,
  deleteEmail,
} from '../controllers/email.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// All email routes require an authenticated user session
router.use(requireAuth);

router.post('/schedule', scheduleEmails);
router.get('/scheduled', getScheduledEmails);
router.get('/sent', getSentEmails);
router.get('/search', searchEmailsHandler);
router.get('/stats', getStats);
router.get('/senders', getSenders);
router.get('/:id', getEmailById);
router.delete('/:id', deleteEmail);

export default router;
