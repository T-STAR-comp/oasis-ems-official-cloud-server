import express from 'express';
import {
  applyCriteriaPromotions,
  buildClassPromotionPreview,
  getPromotionCriteria,
  listPromotionActions,
  listPromotionClasses,
  manualDemoteStudent,
  manualPromoteStudents,
  savePromotionCriteria,
  undoPromotionAction,
} from '../utils/promotion.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireRole('admin'));

router.get('/classes', (_req, res, next) => {
  try {
    res.json({ classes: listPromotionClasses() });
  } catch (error) {
    next(error);
  }
});

router.get('/classes/:classId', (req, res, next) => {
  try {
    res.json(buildClassPromotionPreview(req.params.classId));
  } catch (error) {
    next(error);
  }
});

router.put('/classes/:classId/criteria', (req, res, next) => {
  try {
    const criteria = savePromotionCriteria(req.params.classId, req.body || {});
    res.json({
      message: 'Promotion criteria saved.',
      criteria,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/classes/:classId/apply', (req, res, next) => {
  try {
    const action = applyCriteriaPromotions(
      req.params.classId,
      req.user.full_name || req.user.username || req.user.id,
    );
    res.json({
      message: `Promoted ${action.student_moves.length} student(s) successfully.`,
      action,
      preview: buildClassPromotionPreview(req.params.classId),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/students/promote', (req, res, next) => {
  try {
    const action = manualPromoteStudents({
      studentIds: req.body?.student_ids,
      toClassId: req.body?.to_class_id,
      fromClassId: req.body?.from_class_id,
      performedBy: req.user.full_name || req.user.username || req.user.id,
    });
    res.json({
      message: `Promoted ${action.student_moves.length} student(s) successfully.`,
      action,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/students/demote', (req, res, next) => {
  try {
    const action = manualDemoteStudent({
      studentId: req.body?.student_id,
      toClassId: req.body?.to_class_id,
      performedBy: req.user.full_name || req.user.username || req.user.id,
    });
    res.json({
      message: 'Student class assignment updated successfully.',
      action,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/actions', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 20), 1), 100);
    res.json({ actions: listPromotionActions(limit) });
  } catch (error) {
    next(error);
  }
});

router.post('/actions/:actionId/undo', (req, res, next) => {
  try {
    const action = undoPromotionAction(
      req.params.actionId,
      req.user.full_name || req.user.username || req.user.id,
    );
    res.json({
      message: 'Promotion action undone successfully.',
      action,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/classes/:classId/criteria', (req, res, next) => {
  try {
    res.json({ criteria: getPromotionCriteria(req.params.classId) });
  } catch (error) {
    next(error);
  }
});

export default router;
