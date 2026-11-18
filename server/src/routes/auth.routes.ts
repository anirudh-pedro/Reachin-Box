import { Router } from 'express';
import {
  googleLoginHandler,
  emailLoginHandler,
  getCurrentUserHandler,
  logoutHandler,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/google', googleLoginHandler);
router.post('/login', emailLoginHandler);
router.get('/me', requireAuth, getCurrentUserHandler);
router.post('/logout', logoutHandler);

export default router;
