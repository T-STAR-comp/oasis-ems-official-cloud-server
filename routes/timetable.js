import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess, requireRole } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

router.get('/periods', (_req, res) => {
  const periods = db.prepare(`
    SELECT * FROM timetable_periods ORDER BY sort_order ASC, start_time ASC
  `).all();
  res.json({ periods });
});

router.put('/periods', requireRole('admin'), (req, res) => {
  const periods = Array.isArray(req.body?.periods) ? req.body.periods : [];
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM timetable_periods').run();
    const insert = db.prepare(`
      INSERT INTO timetable_periods (id, name, start_time, end_time, sort_order, is_break)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      insert.run(
        row.id || uuidv4(),
        String(row.name || '').trim(),
        String(row.start_time || '').trim(),
        String(row.end_time || '').trim(),
        Number(row.sort_order ?? index),
        row.is_break ? 1 : 0,
      );
    });
  });
  tx(periods);
  res.json({ message: 'Timetable periods updated.' });
});

router.get('/calendars', requireRole('admin'), (_req, res) => {
  const calendars = db.prepare('SELECT * FROM academic_calendars ORDER BY start_date DESC').all();
  res.json({ calendars });
});

router.post('/calendars', requireRole('admin'), (req, res) => {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO academic_calendars (id, academic_year, term, start_date, end_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    String(req.body?.academic_year || '').trim(),
    String(req.body?.term || '').trim(),
    String(req.body?.start_date || '').trim(),
    String(req.body?.end_date || '').trim(),
  );
  res.status(201).json({ message: 'Calendar entry created.', id });
});

function detectClashes(entries) {
  const clashes = [];
  const slotMap = new Map();
  entries.forEach((entry) => {
    const teacherKey = entry.teacher_id ? `teacher:${entry.teacher_id}` : null;
    const classKey = `class:${entry.class_id}`;
    const slot = `${entry.day_of_week}:${entry.period_id}`;
    [teacherKey, classKey].filter(Boolean).forEach((key) => {
      const mapKey = `${key}:${slot}`;
      if (slotMap.has(mapKey)) {
        clashes.push({ slot, key, entries: [slotMap.get(mapKey), entry] });
      } else {
        slotMap.set(mapKey, entry);
      }
    });
  });
  return clashes;
}

router.get('/entries', (req, res) => {
  const { class_id, teacher_id, status } = req.query;
  const conditions = ['1=1'];
  const params = [];

  if (class_id) {
    if (!ensureClassAccess(req, res, class_id)) return;
    conditions.push('te.class_id = ?');
    params.push(class_id);
  }
  if (teacher_id) {
    conditions.push('te.teacher_id = ?');
    params.push(teacher_id);
  }
  if (status) {
    conditions.push('te.status = ?');
    params.push(status);
  }

  const entries = db.prepare(`
    SELECT te.*, tp.name as period_name, tp.start_time, tp.end_time,
           s.name as subject_name, c.name as class_name
    FROM timetable_entries te
    JOIN timetable_periods tp ON tp.id = te.period_id
    LEFT JOIN subjects s ON s.id = te.subject_id
    JOIN classes c ON c.id = te.class_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY te.day_of_week ASC, tp.sort_order ASC
  `).all(...params);

  res.json({ entries, clashes: detectClashes(entries) });
});

router.post('/entries', requireRole('admin'), (req, res) => {
  const rows = Array.isArray(req.body?.entries) ? req.body.entries : [req.body || {}];
  const insert = db.prepare(`
    INSERT INTO timetable_entries (
      id, class_id, subject_id, teacher_id, period_id, day_of_week, room, status, academic_year, term
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const created = [];
  rows.forEach((row) => {
    const id = row.id || uuidv4();
    insert.run(
      id,
      row.class_id,
      row.subject_id || null,
      row.teacher_id || null,
      row.period_id,
      Number(row.day_of_week),
      row.room || null,
      row.status === 'published' ? 'published' : 'draft',
      row.academic_year || null,
      row.term || null,
    );
    created.push(id);
  });

  res.status(201).json({ message: 'Timetable entries saved.', ids: created });
});

router.put('/entries/replace', requireRole('admin'), (req, res) => {
  const classId = String(req.body?.class_id || '').trim();
  const rows = Array.isArray(req.body?.entries) ? req.body.entries : [];
  if (!classId) {
    return res.status(400).json({ error: 'class_id is required.' });
  }

  const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(classId);
  if (!classExists) {
    return res.status(404).json({ error: 'Class not found.' });
  }

  const tx = db.transaction((entries) => {
    db.prepare('DELETE FROM timetable_entries WHERE class_id = ?').run(classId);
    const insert = db.prepare(`
      INSERT INTO timetable_entries (
        id, class_id, subject_id, teacher_id, period_id, day_of_week, room, status, academic_year, term
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    entries.forEach((row) => {
      insert.run(
        row.id || uuidv4(),
        classId,
        row.subject_id || null,
        row.teacher_id || null,
        row.period_id,
        Number(row.day_of_week),
        row.room || null,
        row.status === 'published' ? 'published' : 'draft',
        row.academic_year || null,
        row.term || null,
      );
    });
  });

  tx(rows);
  res.json({ message: 'Timetable saved for class.', count: rows.length });
});

router.post('/publish', requireRole('admin'), (req, res) => {
  const classId = req.body?.class_id;
  if (!classId) return res.status(400).json({ error: 'class_id is required.' });

  db.prepare(`
    UPDATE timetable_entries
    SET status = 'published', updated_at = CURRENT_TIMESTAMP
    WHERE class_id = ?
  `).run(classId);

  res.json({ message: 'Timetable published for class.' });
});

router.get('/teacher/me', (req, res) => {
  const day = Number(req.query?.day_of_week ?? new Date().getDay());
  const entries = db.prepare(`
    SELECT te.*, tp.name as period_name, tp.start_time, tp.end_time,
           s.name as subject_name, c.name as class_name
    FROM timetable_entries te
    JOIN timetable_periods tp ON tp.id = te.period_id
    LEFT JOIN subjects s ON s.id = te.subject_id
    JOIN classes c ON c.id = te.class_id
    WHERE te.teacher_id = ? AND te.day_of_week = ? AND te.status = 'published'
    ORDER BY tp.sort_order ASC
  `).all(req.user.id, day);

  res.json({ entries });
});

export default router;
