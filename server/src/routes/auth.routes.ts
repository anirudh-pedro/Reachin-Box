import { Router } from 'express';
import {
  googleLoginHandler,
  getCurrentUserHandler,
  logoutHandler,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/google', googleLoginHandler);
router.get('/me', requireAuth, getCurrentUserHandler);
router.post('/logout', logoutHandler);

export default router;
