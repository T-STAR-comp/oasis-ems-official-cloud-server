import express from 'express';
import { getInternalUid } from '../db/database.js';

const router = express.Router();

// Local-only identity endpoint used by the desktop license flow.
router.get('/internal-uid', (req, res) => {
  try {
    const remote = req.ip || req.socket?.remoteAddress || '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote.endsWith('127.0.0.1');
    if (!isLocal) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const uid = getInternalUid();
    res.json({ uid });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load internal UID' });
  }
});

export default router;
