import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

const VALID_STATUSES = new Set(['present', 'absent', 'late', 'excused', 'sick', 'official']);

router.get('/classes/:classId', (req, res) => {
  const { classId } = req.params;
  if (!ensureClassAccess(req, res, classId)) return;

  const date = String(req.query?.date || new Date().toISOString().slice(0, 10));
  const students = db.prepare(`
    SELECT s.*,
      ar.status as attendance_status,
      ar.reason_note,
      ar.id as attendance_id
    FROM students s
    LEFT JOIN attendance_records ar
      ON ar.student_id = s.id AND ar.class_id = s.class_id AND ar.attendance_date = ?
    WHERE s.class_id = ?
    ORDER BY s.name ASC
  `).all(date, classId);

  const summary = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM attendance_records
    WHERE class_id = ? AND attendance_date = ?
    GROUP BY status
  `).all(classId, date);

  res.json({ date, students, summary });
});

router.post('/classes/:classId', (req, res) => {
  const { classId } = req.params;
  if (!ensureClassAccess(req, res, classId)) return;

  const date = String(req.body?.date || new Date().toISOString().slice(0, 10));
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  const recordedBy = req.user.full_name || req.user.username || req.user.id;

  const upsert = db.prepare(`
    INSERT INTO attendance_records (
      id, class_id, student_id, attendance_date, status, reason_note, recorded_by, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(class_id, student_id, attendance_date) DO UPDATE SET
      status = excluded.status,
      reason_note = excluded.reason_note,
      recorded_by = excluded.recorded_by,
      sync_status = excluded.sync_status,
      updated_at = CURRENT_TIMESTAMP
  `);

  let saved = 0;
  records.forEach((record) => {
    const status = String(record.status || 'present').toLowerCase();
    if (!VALID_STATUSES.has(status)) return;
    upsert.run(
      record.id || uuidv4(),
      classId,
      record.student_id,
      date,
      status,
      record.reason_note || null,
      recordedBy,
      record.sync_status || 'synced',
    );
    saved += 1;
  });

  res.json({ message: `Saved attendance for ${saved} student(s).`, date, saved });
});

router.get('/classes/:classId/summary', (req, res) => {
  const { classId } = req.params;
  if (!ensureClassAccess(req, res, classId)) return;

  const from = String(req.query?.from || '').trim();
  const to = String(req.query?.to || '').trim();
  const conditions = ['class_id = ?'];
  const params = [classId];

  if (from) {
    conditions.push('attendance_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('attendance_date <= ?');
    params.push(to);
  }

  const rows = db.prepare(`
    SELECT student_id, status, COUNT(*) as count
    FROM attendance_records
    WHERE ${conditions.join(' AND ')}
    GROUP BY student_id, status
  `).all(...params);

  res.json({ summary: rows });
});

router.get('/students/:studentId', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (!ensureClassAccess(req, res, student.class_id)) return;

  const records = db.prepare(`
    SELECT * FROM attendance_records
    WHERE student_id = ?
    ORDER BY attendance_date DESC
    LIMIT 90
  `).all(student.id);

  res.json({ student, records });
});

export default router;
