import express from 'express';
import db from '../db/database.js';
import { authenticateToken, getAssignedClassIds, isAdminUser, requireRole } from '../middleware/auth.js';
import { calculateStudentResults, getOverallGrade, rankStudentsByExam } from '../utils/grading.js';
import {
  buildAnalyticsOverview,
  readOaeState,
  runAnalyticsSimulation,
  updateOaeState,
} from '../utils/oae.js';

const router = express.Router();

router.use(authenticateToken);

function buildStatus() {
  const state = readOaeState(db);
  return {
    ...state,
    server_mode: 'online',
    detail_level: 'full',
    activation_available: true,
    online_required_for_activation: false,
    simulation_available: state.enabled,
    overview_available: state.enabled,
    activation_message: state.enabled ? null : 'Activate OAE to unlock analytics and simulations.',
  };
}

function ensureEnabled(res) {
  const status = buildStatus();
  if (status.enabled) {
    return status;
  }

  res.status(403).json({
    error: 'Oasis Analytical Engine is not activated for this school.',
    status,
  });
  return null;
}

router.get('/status', (_req, res) => {
  res.json(buildStatus());
});

router.post('/activate', requireRole('admin'), (req, res, next) => {
  try {
    updateOaeState(db, {
      enabled: true,
      activatedBy: req.user.full_name || req.user.username || req.user.id,
    });

    res.json({
      message: 'Oasis Analytical Engine activated successfully.',
      status: buildStatus(),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/deactivate', requireRole('admin'), (req, res, next) => {
  try {
    updateOaeState(db, {
      enabled: false,
      activatedBy: null,
    });

    res.json({
      message: 'Oasis Analytical Engine deactivated.',
      status: buildStatus(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/overview', (req, res, next) => {
  const status = ensureEnabled(res);
  if (!status) return;

  try {
    const analytics = buildAnalyticsOverview({
      db,
      user: req.user,
      examId: req.query?.exam_id,
      classId: req.query?.class_id,
      detailLevel: 'full',
      calculateStudentResults,
      getOverallGrade,
      rankStudentsByExam,
      isAdminUser,
      getAssignedClassIds,
    });

    res.json({ status, analytics });
  } catch (error) {
    next(error);
  }
});

router.post('/simulate', (req, res, next) => {
  const status = ensureEnabled(res);
  if (!status) return;

  try {
    const simulation = runAnalyticsSimulation({
      db,
      user: req.user,
      examId: req.body?.exam_id,
      classId: req.body?.class_id,
      studentId: req.body?.student_id,
      subjectId: req.body?.subject_id,
      uplift: req.body?.uplift,
      targetAverage: req.body?.target_average,
      calculateStudentResults,
      isAdminUser,
      getAssignedClassIds,
    });

    if (!simulation) {
      return res.status(404).json({ error: 'No exam data matched the selected simulation scope.' });
    }

    return res.json({ status, simulation });
  } catch (error) {
    return next(error);
  }
});

export default router;
