import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess, getAssignedClassIds, isAdminUser, requireRole } from '../middleware/auth.js';
import { classValidation, idValidation } from '../middleware/validate.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get all classes
router.get('/', (req, res) => {
  let classes = db.prepare(`
    SELECT c.*,
      COALESCE(st.student_count, 0) AS student_count,
      COALESCE(sub.subject_count, 0) AS subject_count,
      COALESCE(sub.compulsory_subject_count, 0) AS compulsory_subject_count,
      COALESCE(sub.optional_subject_count, 0) AS optional_subject_count
    FROM classes c
    LEFT JOIN (
      SELECT class_id, COUNT(*) AS student_count
      FROM students
      GROUP BY class_id
    ) st ON st.class_id = c.id
    LEFT JOIN (
      SELECT class_id,
        COUNT(*) AS subject_count,
        SUM(CASE WHEN is_compulsory = 1 THEN 1 ELSE 0 END) AS compulsory_subject_count,
        SUM(CASE WHEN is_compulsory = 0 THEN 1 ELSE 0 END) AS optional_subject_count
      FROM subjects
      GROUP BY class_id
    ) sub ON sub.class_id = c.id
    ORDER BY c.year DESC, c.name ASC
  `).all();
  if (!isAdminUser(req.user)) {
    const allowed = new Set(getAssignedClassIds(req.user.id));
    classes = classes.filter((classRoom) => allowed.has(classRoom.id));
  }

  res.json({ classes });
});

// Get single class with students and subjects
router.get('/:id', idValidation, (req, res) => {
  const { id } = req.params;

  const classRoom = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);

  if (!classRoom) {
    return res.status(404).json({ error: 'Class not found' });
  }
  if (!ensureClassAccess(req, res, id)) return;

  const students = db.prepare(`
    SELECT st.*,
      (
        SELECT COUNT(*)
        FROM student_subjects ss
        JOIN subjects sub ON sub.id = ss.subject_id
        WHERE ss.student_id = st.id AND sub.class_id = st.class_id
      ) as selected_subject_count
    FROM students st
    WHERE st.class_id = ?
    ORDER BY st.name ASC
  `).all(id);

  const subjectIdsByStudent = db.prepare(`
    SELECT ss.student_id, ss.subject_id
    FROM student_subjects ss
    JOIN students st ON st.id = ss.student_id
    JOIN subjects sub ON sub.id = ss.subject_id
    WHERE st.class_id = ? AND sub.class_id = ?
  `).all(id, id);
  const studentSubjectMap = new Map();
  subjectIdsByStudent.forEach((row) => {
    const list = studentSubjectMap.get(row.student_id) || [];
    list.push(row.subject_id);
    studentSubjectMap.set(row.student_id, list);
  });
  const hydratedStudents = students.map((student) => ({
    ...student,
    subject_ids: studentSubjectMap.get(student.id) || []
  }));

  const subjects = db.prepare(`
    SELECT sub.*,
      (
        SELECT COUNT(*)
        FROM student_subjects ss
        JOIN students st ON st.id = ss.student_id
        WHERE ss.subject_id = sub.id AND st.class_id = sub.class_id
      ) as selected_student_count
    FROM subjects sub
    WHERE sub.class_id = ?
    ORDER BY sub.name ASC
  `).all(id);

  res.json({
    class: {
      ...classRoom,
      students: hydratedStudents,
      subjects
    }
  });
});

// Create new class
router.post('/', requireRole('admin', 'secretary'), classValidation.create, (req, res, next) => {
  try {
    const { name, year, min_subjects = 6, max_subjects = 12 } = req.body;
    const minSubjects = Number(min_subjects);
    const maxSubjects = Number(max_subjects);
    if (!Number.isInteger(minSubjects) || !Number.isInteger(maxSubjects) || minSubjects < 1 || maxSubjects < minSubjects) {
      return res.status(400).json({ error: 'Invalid subject limits: min_subjects must be >= 1 and max_subjects must be >= min_subjects' });
    }
    const id = uuidv4();

    db.prepare(`
      INSERT INTO classes (id, name, year, min_subjects, max_subjects)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, year, minSubjects, maxSubjects);

    const classRoom = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);

    res.status(201).json({
      message: 'Class created successfully',
      class: classRoom
    });
  } catch (error) {
    next(error);
  }
});

// Update class
router.put('/:id', requireRole('admin'), classValidation.update, (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, year, min_subjects, max_subjects } = req.body;

    const existing = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (year !== undefined) {
      updates.push('year = ?');
      values.push(year);
    }
    const nextMin = min_subjects !== undefined ? Number(min_subjects) : Number(existing.min_subjects ?? 6);
    const nextMax = max_subjects !== undefined ? Number(max_subjects) : Number(existing.max_subjects ?? 12);
    if (!Number.isInteger(nextMin) || !Number.isInteger(nextMax) || nextMin < 1 || nextMax < nextMin) {
      return res.status(400).json({ error: 'Invalid subject limits: min_subjects must be >= 1 and max_subjects must be >= min_subjects' });
    }
    if (min_subjects !== undefined) {
      updates.push('min_subjects = ?');
      values.push(nextMin);
    }
    if (max_subjects !== undefined) {
      updates.push('max_subjects = ?');
      values.push(nextMax);
    }

    const outOfRange = db.prepare(`
      SELECT st.id, st.name,
             COUNT(ss.subject_id) as selected_subject_count
      FROM students st
      LEFT JOIN student_subjects ss ON ss.student_id = st.id
      LEFT JOIN subjects sub ON sub.id = ss.subject_id
      WHERE st.class_id = ? AND (sub.id IS NULL OR sub.class_id = st.class_id)
      GROUP BY st.id, st.name
      HAVING selected_subject_count < ? OR selected_subject_count > ?
    `).all(id, nextMin, nextMax);
    if (outOfRange.length > 0) {
      return res.status(400).json({
        error: 'Cannot update class limits because some students are outside the allowed subject range',
        students: outOfRange
      });
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      db.prepare(`
        UPDATE classes SET ${updates.join(', ')} WHERE id = ?
      `).run(...values);
    }

    const classRoom = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);

    res.json({
      message: 'Class updated successfully',
      class: classRoom
    });
  } catch (error) {
    next(error);
  }
});

// Delete class (cascades to students, subjects, exams, results)
router.delete('/:id', requireRole('admin'), idValidation, (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Class not found' });
    }

    db.prepare('DELETE FROM classes WHERE id = ?').run(id);

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
