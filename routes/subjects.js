import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess, getAssignedClassIds, isAdminUser, requireRole } from '../middleware/auth.js';
import { subjectValidation, idValidation } from '../middleware/validate.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

function getClassSubjectLimits(classId) {
  const classRoom = db.prepare('SELECT id, min_subjects, max_subjects FROM classes WHERE id = ?').get(classId);
  if (!classRoom) return null;
  return {
    minSubjects: Number(classRoom.min_subjects ?? 6),
    maxSubjects: Number(classRoom.max_subjects ?? 12),
  };
}

function getStudentSubjectCountMap(classId) {
  const rows = db.prepare(`
    SELECT st.id as student_id, COUNT(ss.subject_id) as selected_subject_count
    FROM students st
    LEFT JOIN student_subjects ss ON ss.student_id = st.id
    LEFT JOIN subjects sub ON sub.id = ss.subject_id
    WHERE st.class_id = ? AND (sub.id IS NULL OR sub.class_id = st.class_id)
    GROUP BY st.id
  `).all(classId);

  const map = new Map();
  rows.forEach((row) => map.set(row.student_id, Number(row.selected_subject_count || 0)));
  return map;
}

function canAddCompulsorySubjectForAll(classId, additionalSubjects = 1) {
  const limits = getClassSubjectLimits(classId);
  const selectedCounts = getStudentSubjectCountMap(classId);
  const students = db.prepare('SELECT id FROM students WHERE class_id = ?').all(classId);
  const overLimit = students.some((student) => {
    const currentCount = Number(selectedCounts.get(student.id) || 0);
    return currentCount + additionalSubjects > limits.maxSubjects;
  });
  return !overLimit;
}

// Get all subjects (optionally filter by class)
router.get('/', (req, res) => {
  const { class_id } = req.query;
  if (class_id && !ensureClassAccess(req, res, class_id)) return;

  let query = `
    SELECT s.*, c.name as class_name, c.year as class_year,
           (
             SELECT COUNT(*) FROM student_subjects ss
             JOIN students st ON st.id = ss.student_id
             WHERE ss.subject_id = s.id AND st.class_id = s.class_id
           ) as selected_student_count
    FROM subjects s
    JOIN classes c ON s.class_id = c.id
  `;
  const params = [];

  if (class_id) {
    query += ' WHERE s.class_id = ?';
    params.push(class_id);
  }

  query += ' ORDER BY s.name ASC';

  let subjects = db.prepare(query).all(...params);
  if (!isAdminUser(req.user)) {
    const allowed = new Set(getAssignedClassIds(req.user.id));
    subjects = subjects.filter((subject) => allowed.has(subject.class_id));
  }

  res.json({ subjects });
});

// Get single subject
router.get('/:id', idValidation, (req, res) => {
  const { id } = req.params;

  const subject = db.prepare(`
    SELECT s.*, c.name as class_name, c.year as class_year,
           (
             SELECT COUNT(*) FROM student_subjects ss
             JOIN students st ON st.id = ss.student_id
             WHERE ss.subject_id = s.id AND st.class_id = s.class_id
           ) as selected_student_count
    FROM subjects s
    JOIN classes c ON s.class_id = c.id
    WHERE s.id = ?
  `).get(id);

  if (!subject) {
    return res.status(404).json({ error: 'Subject not found' });
  }
  if (!ensureClassAccess(req, res, subject.class_id)) return;

  res.json({ subject });
});

// Create new subject
router.post('/', subjectValidation.create, (req, res, next) => {
  try {
    const { class_id, name, code, is_compulsory = true } = req.body;

    // Verify class exists
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(class_id);
    if (!classExists) {
      return res.status(404).json({ error: 'Class not found' });
    }
    if (!ensureClassAccess(req, res, class_id)) return;

    // Check if subject code already exists in this class
    const existing = db.prepare(
      'SELECT id FROM subjects WHERE class_id = ? AND code = ?'
    ).get(class_id, code);
    
    if (existing) {
      return res.status(409).json({ error: 'Subject code already exists in this class' });
    }

    const compulsoryFlag = is_compulsory === false || is_compulsory === 0 ? 0 : 1;
    if (compulsoryFlag === 1 && !canAddCompulsorySubjectForAll(class_id, 1)) {
      return res.status(400).json({
        error: 'Cannot add compulsory subject because it would exceed max subject limit for some students'
      });
    }
    const id = uuidv4();

    db.prepare(`
      INSERT INTO subjects (id, class_id, name, code, is_compulsory, teacher_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, class_id, name, code, compulsoryFlag, null);

    if (compulsoryFlag === 1) {
      db.prepare(`
        INSERT OR IGNORE INTO student_subjects (student_id, subject_id)
        SELECT id, ? FROM students WHERE class_id = ?
      `).run(id, class_id);
    }

    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);

    res.status(201).json({
      message: 'Subject created successfully',
      subject
    });
  } catch (error) {
    next(error);
  }
});

// Bulk create subjects
router.post('/bulk', authenticateToken, (req, res, next) => {
  try {
    const { class_id, subjects } = req.body;

    if (!class_id || !Array.isArray(subjects) || subjects.length === 0) {
      return res.status(400).json({ error: 'class_id and subjects array required' });
    }

    // Verify class exists
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(class_id);
    if (!classExists) {
      return res.status(404).json({ error: 'Class not found' });
    }
    if (!ensureClassAccess(req, res, class_id)) return;

    // Get existing subject codes in this class
    const existingCodes = new Set(
      db.prepare('SELECT code FROM subjects WHERE class_id = ?')
        .all(class_id)
        .map(s => s.code.toLowerCase())
    );

    const insert = db.prepare(`
      INSERT INTO subjects (id, class_id, name, code, is_compulsory, teacher_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const assignCompulsoryToAll = db.prepare(`
      INSERT OR IGNORE INTO student_subjects (student_id, subject_id)
      SELECT id, ? FROM students WHERE class_id = ?
    `);

    const insertMany = db.transaction((subjects) => {
      const created = [];
      const skipped = [];

      for (const s of subjects) {
        if (!s.name || !s.code) {
          skipped.push({ ...s, reason: 'Missing name or code' });
          continue;
        }

        if (existingCodes.has(s.code.toLowerCase())) {
          skipped.push({ ...s, reason: 'Duplicate code' });
          continue;
        }

        const id = uuidv4();
        const compulsoryFlag = s.is_compulsory === false || s.is_compulsory === 0 ? 0 : 1;
        if (compulsoryFlag === 1 && !canAddCompulsorySubjectForAll(class_id, 1)) {
          skipped.push({ ...s, reason: 'Would exceed class max subjects for some students' });
          continue;
        }
        insert.run(id, class_id, s.name.trim(), s.code.trim(), compulsoryFlag, null);
        if (compulsoryFlag === 1) {
          assignCompulsoryToAll.run(id, class_id);
        }
        existingCodes.add(s.code.toLowerCase());
        created.push({ id, name: s.name, code: s.code, is_compulsory: compulsoryFlag });
      }

      return { created, skipped };
    });

    const result = insertMany(subjects);

    res.status(201).json({
      message: `Created ${result.created.length} subjects, skipped ${result.skipped.length}`,
      created: result.created.length,
      skipped: result.skipped.length,
      skippedDetails: result.skipped
    });
  } catch (error) {
    next(error);
  }
});

// Update subject
router.put('/:id', idValidation, (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, code, is_compulsory } = req.body;

    const existing = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Subject not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    // Check if new code conflicts with another subject
    if (code && code !== existing.code) {
      const codeConflict = db.prepare(
        'SELECT id FROM subjects WHERE class_id = ? AND code = ? AND id != ?'
      ).get(existing.class_id, code, id);
      
      if (codeConflict) {
        return res.status(409).json({ error: 'Subject code already exists in this class' });
      }
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (code !== undefined) {
      updates.push('code = ?');
      values.push(code);
    }
    let nextCompulsory = Number(existing.is_compulsory || 0);
    if (is_compulsory !== undefined) {
      nextCompulsory = is_compulsory === false || is_compulsory === 0 ? 0 : 1;
      if (nextCompulsory === 1 && Number(existing.is_compulsory || 0) !== 1 && !canAddCompulsorySubjectForAll(existing.class_id, 1)) {
        return res.status(400).json({
          error: 'Cannot mark subject as compulsory because it would exceed max subject limit for some students'
        });
      }
      updates.push('is_compulsory = ?');
      values.push(nextCompulsory);
    }

    if (updates.length > 0) {
      values.push(id);
      db.prepare(`UPDATE subjects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    if (is_compulsory !== undefined) {
      if (nextCompulsory === 1) {
        db.prepare(`
          INSERT OR IGNORE INTO student_subjects (student_id, subject_id)
          SELECT id, ? FROM students WHERE class_id = ?
        `).run(id, existing.class_id);
      }
    }

    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);

    res.json({
      message: 'Subject updated successfully',
      subject
    });
  } catch (error) {
    next(error);
  }
});

// Delete subject
router.delete('/:id', idValidation, (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Subject not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    const limits = getClassSubjectLimits(existing.class_id);
    const students = db.prepare('SELECT id FROM students WHERE class_id = ?').all(existing.class_id);
    const selectedCounts = getStudentSubjectCountMap(existing.class_id);
    const currentlyAssigned = new Set(
      db.prepare(`
        SELECT student_id
        FROM student_subjects
        WHERE subject_id = ?
      `).all(id).map((row) => row.student_id)
    );
    const outOfRange = students
      .map((student) => {
        const currentCount = Number(selectedCounts.get(student.id) || 0);
        const nextCount = currentlyAssigned.has(student.id) ? currentCount - 1 : currentCount;
        return { student_id: student.id, selected_subject_count: nextCount };
      })
      .filter((row) => row.selected_subject_count < limits.minSubjects || row.selected_subject_count > limits.maxSubjects);

    if (outOfRange.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete subject because it would violate class subject limits for some students',
        students: outOfRange
      });
    }

    db.prepare('DELETE FROM subjects WHERE id = ?').run(id);

    res.json({ message: 'Subject deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// Assign/edit teacher signature name for a subject (admin only)
router.put('/:id/teacher', requireRole('admin'), idValidation, (req, res, next) => {
  try {
    const { id } = req.params;
    const { teacher_name } = req.body;

    const existing = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Subject not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    db.prepare(`
      UPDATE subjects
      SET teacher_name = ?
      WHERE id = ?
    `).run(teacher_name ? String(teacher_name).trim() : null, id);

    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    res.json({
      message: 'Subject teacher updated successfully',
      subject,
    });
  } catch (error) {
    next(error);
  }
});

// Assign students to an optional subject
router.put('/:id/students', idValidation, (req, res, next) => {
  try {
    const { id } = req.params;
    const { student_ids } = req.body;

    if (!Array.isArray(student_ids)) {
      return res.status(400).json({ error: 'student_ids must be an array' });
    }

    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }
    if (!ensureClassAccess(req, res, subject.class_id)) return;
    if (Number(subject.is_compulsory || 0) === 1) {
      return res.status(400).json({ error: 'Compulsory subjects are automatically assigned to all students' });
    }

    const studentsInClass = db.prepare('SELECT id FROM students WHERE class_id = ?').all(subject.class_id).map((s) => s.id);
    const studentSet = new Set(studentsInClass);
    const uniqueStudentIds = Array.from(new Set(student_ids));
    const invalidStudentId = uniqueStudentIds.find((studentId) => !studentSet.has(studentId));
    if (invalidStudentId) {
      return res.status(400).json({ error: `Student ${invalidStudentId} does not belong to this class` });
    }

    const limits = getClassSubjectLimits(subject.class_id);
    const selectedCounts = getStudentSubjectCountMap(subject.class_id);
    const currentlyAssigned = new Set(
      db.prepare('SELECT student_id FROM student_subjects WHERE subject_id = ?').all(id).map((row) => row.student_id)
    );
    const nextAssigned = new Set(uniqueStudentIds);

    const outOfRange = studentsInClass
      .map((studentId) => {
        const currentCount = Number(selectedCounts.get(studentId) || 0);
        const currentlyHas = currentlyAssigned.has(studentId);
        const nextHas = nextAssigned.has(studentId);
        const nextCount = currentCount + (nextHas ? 1 : 0) - (currentlyHas ? 1 : 0);
        return { student_id: studentId, selected_subject_count: nextCount };
      })
      .filter((row) => row.selected_subject_count > limits.maxSubjects);

    if (outOfRange.length > 0) {
      return res.status(400).json({
        error: 'Assignment would exceed maximum subject limit for some students',
        students: outOfRange
      });
    }

    const belowMin = studentsInClass
      .map((studentId) => {
        const currentCount = Number(selectedCounts.get(studentId) || 0);
        const currentlyHas = currentlyAssigned.has(studentId);
        const nextHas = nextAssigned.has(studentId);
        const nextCount = currentCount + (nextHas ? 1 : 0) - (currentlyHas ? 1 : 0);
        return { student_id: studentId, selected_subject_count: nextCount };
      })
      .filter((row) => row.selected_subject_count < limits.minSubjects);

    const replaceAssignments = db.transaction(() => {
      db.prepare('DELETE FROM student_subjects WHERE subject_id = ?').run(id);
      const insert = db.prepare('INSERT OR IGNORE INTO student_subjects (student_id, subject_id) VALUES (?, ?)');
      uniqueStudentIds.forEach((studentId) => insert.run(studentId, id));
    });
    replaceAssignments();

    res.json({
      message: 'Subject assignments updated successfully',
      subject_id: id,
      assigned_students: uniqueStudentIds.length,
      students_below_min: belowMin
    });
  } catch (error) {
    next(error);
  }
});

export default router;
