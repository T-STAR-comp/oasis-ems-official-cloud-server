import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess, getAssignedClassIds, isAdminUser } from '../middleware/auth.js';
import { studentValidation, idValidation } from '../middleware/validate.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

function getClassSubjectPolicy(classId) {
  const classRoom = db.prepare('SELECT min_subjects, max_subjects FROM classes WHERE id = ?').get(classId);
  if (!classRoom) return null;
  return {
    minSubjects: Number(classRoom.min_subjects ?? 6),
    maxSubjects: Number(classRoom.max_subjects ?? 12),
  };
}

function getClassSubjects(classId) {
  return db.prepare('SELECT id, is_compulsory FROM subjects WHERE class_id = ?').all(classId);
}

function normalizeStudentSubjects(classId, subjectIds) {
  const subjects = getClassSubjects(classId);
  const allSubjectIds = new Set(subjects.map((s) => s.id));
  const compulsoryIds = new Set(subjects.filter((s) => Number(s.is_compulsory || 0) === 1).map((s) => s.id));
  const selected = new Set(Array.isArray(subjectIds) ? subjectIds : []);

  for (const requiredId of compulsoryIds) {
    selected.add(requiredId);
  }

  const filtered = Array.from(selected).filter((id) => allSubjectIds.has(id));
  const policy = getClassSubjectPolicy(classId);
  if (!policy) {
    return { valid: false, error: 'Class not found' };
  }
  if (filtered.length < policy.minSubjects || filtered.length > policy.maxSubjects) {
    return {
      valid: false,
      error: `Student must be assigned between ${policy.minSubjects} and ${policy.maxSubjects} subjects`,
      selectedCount: filtered.length
    };
  }

  return { valid: true, subjectIds: filtered };
}

// Get all students (optionally filter by class)
router.get('/', (req, res) => {
  const { class_id } = req.query;
  if (class_id && !ensureClassAccess(req, res, class_id)) return;

  let query = `
    SELECT s.*, c.name as class_name, c.year as class_year,
           (
             SELECT COUNT(*)
             FROM student_subjects ss
             JOIN subjects sub ON sub.id = ss.subject_id
             WHERE ss.student_id = s.id AND sub.class_id = s.class_id
           ) as selected_subject_count
    FROM students s
    JOIN classes c ON s.class_id = c.id
  `;
  const params = [];

  if (class_id) {
    query += ' WHERE s.class_id = ?';
    params.push(class_id);
  }

  query += ' ORDER BY s.name ASC';

  let students = db.prepare(query).all(...params);
  if (!isAdminUser(req.user)) {
    const allowed = new Set(getAssignedClassIds(req.user.id));
    students = students.filter((student) => allowed.has(student.class_id));
  }
  const studentIds = students.map((s) => s.id);
  const subjectRows = studentIds.length > 0
    ? db.prepare(`
      SELECT ss.student_id, ss.subject_id
      FROM student_subjects ss
      WHERE ss.student_id IN (${studentIds.map(() => '?').join(',')})
    `).all(...studentIds)
    : [];
  const byStudent = new Map();
  subjectRows.forEach((row) => {
    const list = byStudent.get(row.student_id) || [];
    list.push(row.subject_id);
    byStudent.set(row.student_id, list);
  });
  const hydratedStudents = students.map((student) => ({
    ...student,
    subject_ids: byStudent.get(student.id) || []
  }));

  res.json({ students: hydratedStudents });
});

// Get single student with results
router.get('/:id', idValidation, (req, res) => {
  const { id } = req.params;

  const student = db.prepare(`
    SELECT s.*, c.name as class_name, c.year as class_year
    FROM students s
    JOIN classes c ON s.class_id = c.id
    WHERE s.id = ?
  `).get(id);

  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }
  if (!ensureClassAccess(req, res, student.class_id)) return;

  // Get exam results for this student
  const results = db.prepare(`
    SELECT er.*, e.name as exam_name, e.type as exam_type, 
           e.term, e.year as exam_year, sub.name as subject_name, sub.code as subject_code
    FROM exam_results er
    JOIN exams e ON er.exam_id = e.id
    JOIN subjects sub ON er.subject_id = sub.id
    WHERE er.student_id = ?
    ORDER BY e.created_at DESC
  `).all(id);

  const subjectIds = db.prepare(`
    SELECT ss.subject_id
    FROM student_subjects ss
    JOIN subjects sub ON sub.id = ss.subject_id
    WHERE ss.student_id = ? AND sub.class_id = ?
  `).all(id, student.class_id).map((row) => row.subject_id);

  res.json({
    student: {
      ...student,
      subject_ids: subjectIds,
      results
    }
  });
});

// Create new student
router.post('/', studentValidation.create, (req, res, next) => {
  try {
    const { 
      class_id, name, gender, 
      date_of_birth, guardian_name, guardian_phone, admission_number, subject_ids
    } = req.body;

    // Verify class exists
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(class_id);
    if (!classExists) {
      return res.status(404).json({ error: 'Class not found' });
    }
    if (!ensureClassAccess(req, res, class_id)) return;

    const id = uuidv4();
    const normalized = normalizeStudentSubjects(class_id, subject_ids);
    if (!normalized.valid) {
      return res.status(400).json({ error: normalized.error });
    }

    const createStudent = db.transaction(() => {
      db.prepare(`
        INSERT INTO students (id, class_id, name, gender, date_of_birth, guardian_name, guardian_phone, admission_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, class_id, name, gender, date_of_birth || null, guardian_name || null, guardian_phone || null, admission_number || null);

      const insertEnrollment = db.prepare('INSERT OR IGNORE INTO student_subjects (student_id, subject_id) VALUES (?, ?)');
      normalized.subjectIds.forEach((subjectId) => insertEnrollment.run(id, subjectId));
    });
    createStudent();

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);

    res.status(201).json({
      message: 'Student created successfully',
      student
    });
  } catch (error) {
    next(error);
  }
});

// Bulk create students
router.post('/bulk', authenticateToken, (req, res, next) => {
  try {
    const { class_id, students } = req.body;

    if (!class_id || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: 'class_id and students array required' });
    }

    // Verify class exists
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(class_id);
    if (!classExists) {
      return res.status(404).json({ error: 'Class not found' });
    }
    if (!ensureClassAccess(req, res, class_id)) return;

    // Get existing student names in this class
    const existingNames = new Set(
      db.prepare('SELECT LOWER(name) as name FROM students WHERE class_id = ?')
        .all(class_id)
        .map(s => s.name)
    );

    const insert = db.prepare(`
      INSERT INTO students (id, class_id, name, gender, date_of_birth, guardian_name, guardian_phone, admission_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEnrollment = db.prepare('INSERT OR IGNORE INTO student_subjects (student_id, subject_id) VALUES (?, ?)');
    const normalizedDefaults = normalizeStudentSubjects(class_id, []);
    if (!normalizedDefaults.valid) {
      return res.status(400).json({ error: normalizedDefaults.error });
    }

    const insertMany = db.transaction((students) => {
      const created = [];
      const skipped = [];

      for (const s of students) {
        if (!s.name || typeof s.name !== 'string') {
          skipped.push({ ...s, reason: 'Invalid name' });
          continue;
        }

        if (existingNames.has(s.name.toLowerCase())) {
          skipped.push({ ...s, reason: 'Duplicate name' });
          continue;
        }

        const id = uuidv4();
        const gender = s.gender === 'Female' ? 'Female' : 'Male';

        insert.run(
          id,
          class_id,
          s.name.trim(),
          gender,
          s.date_of_birth || null,
          s.guardian_name || null,
          s.guardian_phone || null,
          s.admission_number || null
        );
        normalizedDefaults.subjectIds.forEach((subjectId) => insertEnrollment.run(id, subjectId));

        existingNames.add(s.name.toLowerCase());
        created.push({ id, name: s.name });
      }

      return { created, skipped };
    });

    const result = insertMany(students);

    res.status(201).json({
      message: `Created ${result.created.length} students, skipped ${result.skipped.length}`,
      created: result.created.length,
      skipped: result.skipped.length,
      skippedDetails: result.skipped
    });
  } catch (error) {
    next(error);
  }
});

// Update student
router.put('/:id', studentValidation.update, (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, gender, date_of_birth, guardian_name, guardian_phone, admission_number, subject_ids } = req.body;

    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (gender !== undefined) {
      updates.push('gender = ?');
      values.push(gender);
    }
    if (date_of_birth !== undefined) {
      updates.push('date_of_birth = ?');
      values.push(date_of_birth);
    }
    if (guardian_name !== undefined) {
      updates.push('guardian_name = ?');
      values.push(guardian_name);
    }
    if (guardian_phone !== undefined) {
      updates.push('guardian_phone = ?');
      values.push(guardian_phone);
    }
    if (admission_number !== undefined) {
      updates.push('admission_number = ?');
      values.push(admission_number);
    }

    if (subject_ids !== undefined) {
      const normalized = normalizeStudentSubjects(existing.class_id, subject_ids);
      if (!normalized.valid) {
        return res.status(400).json({ error: normalized.error });
      }
      const updateWithSubjects = db.transaction(() => {
        if (updates.length > 0) {
          updates.push('updated_at = CURRENT_TIMESTAMP');
          values.push(id);

          db.prepare(`
            UPDATE students SET ${updates.join(', ')} WHERE id = ?
          `).run(...values);
        }
        db.prepare('DELETE FROM student_subjects WHERE student_id = ?').run(id);
        const insertEnrollment = db.prepare('INSERT OR IGNORE INTO student_subjects (student_id, subject_id) VALUES (?, ?)');
        normalized.subjectIds.forEach((subjectId) => insertEnrollment.run(id, subjectId));
      });
      updateWithSubjects();
    } else if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      db.prepare(`UPDATE students SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);

    res.json({
      message: 'Student updated successfully',
      student
    });
  } catch (error) {
    next(error);
  }
});

// Delete student
router.delete('/:id', idValidation, (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    db.prepare('DELETE FROM students WHERE id = ?').run(id);

    res.json({ message: 'Student deleted successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
