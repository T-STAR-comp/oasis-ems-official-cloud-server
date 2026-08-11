import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess, getAssignedClassIds, isAdminUser } from '../middleware/auth.js';
import { examValidation, idValidation } from '../middleware/validate.js';
import { getGrade, rankStudentsByExam, getGradeCriteria } from '../utils/grading.js';
import { buildMergedResults } from '../utils/mergeExams.js';
import { ALL_GRADING_SYSTEMS, getGradingSystemsForCountry, isSupportedGradingSystem, normalizeCountry } from '../utils/education.js';

const router = express.Router();

function isMidtermExam(examOrType) {
  const type = typeof examOrType === 'string' ? examOrType : examOrType?.type;
  return String(type || '').toLowerCase() === 'midterm';
}

// All routes require authentication
router.use(authenticateToken);

function parseCustomCriteria(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function loadSubjectProfileMap(examId) {
  const rows = db.prepare(`
    SELECT subject_id, grading_system, custom_criteria
    FROM exam_subject_grading_profiles
    WHERE exam_id = ?
  `).all(examId);
  const profileMap = new Map();
  rows.forEach((row) => {
    profileMap.set(row.subject_id, {
      gradingSystem: row.grading_system,
      customCriteria: parseCustomCriteria(row.custom_criteria),
    });
  });
  return profileMap;
}

function resolveSubjectGrading(profileMap, subjectId, fallbackSystem) {
  const profile = profileMap.get(subjectId);
  if (!profile) {
    return { gradingSystem: fallbackSystem, customCriteria: null };
  }
  return {
    gradingSystem: profile.gradingSystem || fallbackSystem,
    customCriteria: profile.customCriteria || null,
  };
}

function loadSubjectMaxScoreRows(examId) {
  return db.prepare(`
    SELECT subject_id, max_score
    FROM exam_subject_max_scores
    WHERE exam_id = ?
    ORDER BY subject_id ASC
  `).all(examId);
}

function saveSubjectMaxScores(examId, classId, subjectMaxScores) {
  if (!Array.isArray(subjectMaxScores)) return;
  const validSubjects = new Set(
    db.prepare('SELECT id FROM subjects WHERE class_id = ?').all(classId).map((row) => row.id),
  );
  const upsert = db.prepare(`
    INSERT INTO exam_subject_max_scores (exam_id, subject_id, max_score)
    VALUES (?, ?, ?)
    ON CONFLICT(exam_id, subject_id) DO UPDATE SET
      max_score = excluded.max_score,
      updated_at = CURRENT_TIMESTAMP
  `);
  subjectMaxScores.forEach((row) => {
    const subjectId = String(row?.subject_id || '').trim();
    const parsed = Number(row?.max_score);
    if (!subjectId || !validSubjects.has(subjectId) || !Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    upsert.run(examId, subjectId, parsed);
  });
}

function normalizeLockStatus(exam) {
  const status = String(exam?.lock_status || 'none').toLowerCase();
  return ['none', 'temporary', 'permanent'].includes(status) ? status : 'none';
}

function ensureExamScoresEditable(exam, res) {
  const lockStatus = normalizeLockStatus(exam);
  if (lockStatus === 'none') return true;
  const reason = lockStatus === 'permanent'
    ? 'This exam is permanently locked and cannot be edited.'
    : 'This exam is temporarily locked. Ask an admin to unlock it before editing.';
  res.status(423).json({ error: reason, lock_status: lockStatus });
  return false;
}

function getSchoolCountry() {
  const row = db.prepare('SELECT country FROM school_info WHERE id = 1').get();
  return normalizeCountry(row?.country);
}

function getAllowedGradingSystems() {
  return getGradingSystemsForCountry(getSchoolCountry());
}

function getUnavailableGradingMessage(system) {
  if (!isSupportedGradingSystem(system)) {
    return 'Unsupported grading system.';
  }
  return `${system} grading is not available for this school.`;
}

function ensureAllowedGradingSystem(system, res) {
  const normalized = String(system || '').trim();
  if (!isSupportedGradingSystem(normalized)) {
    res.status(400).json({ error: 'Invalid grading system' });
    return false;
  }
  if (!getAllowedGradingSystems().includes(normalized)) {
    res.status(400).json({ error: getUnavailableGradingMessage(normalized) });
    return false;
  }
  return true;
}

// Get all exams (optionally filter by class)
router.get('/', (req, res) => {
  const { class_id } = req.query;
  if (class_id && !ensureClassAccess(req, res, class_id)) return;

  let query = `
    SELECT e.*, c.name as class_name, c.year as class_year,
      ce.name as component_exam_name,
      ce.max_score as component_exam_max_score,
      ce.type as component_exam_type,
      (
        SELECT COALESCE(u.full_name, u.username)
        FROM users u
        JOIN user_class_assignments uca ON uca.user_id = u.id
        WHERE uca.class_id = e.class_id AND u.role = 'teacher'
        ORDER BY (
          SELECT COUNT(*) FROM user_class_assignments x WHERE x.user_id = u.id
        ) ASC, u.created_at ASC
        LIMIT 1
      ) as form_teacher_name,
      (SELECT COUNT(*) FROM exam_merge_sources ems WHERE ems.exam_id = e.id) as merged_source_count,
      (SELECT COUNT(DISTINCT student_id) FROM exam_results WHERE exam_id = e.id) as students_graded
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
  `;
  const params = [];

  if (class_id) {
    query += ' WHERE e.class_id = ?';
    params.push(class_id);
  }

  query += ' ORDER BY e.created_at DESC';

  let exams = db.prepare(query).all(...params);
  if (!isAdminUser(req.user)) {
    const allowed = new Set(getAssignedClassIds(req.user.id));
    exams = exams.filter((exam) => allowed.has(exam.class_id));
  }

  res.json({ exams });
});

// Get single exam with full results and rankings
router.get('/:id', idValidation, (req, res) => {
  const { id } = req.params;

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type,
           (
             SELECT COALESCE(u.full_name, u.username)
             FROM users u
             JOIN user_class_assignments uca ON uca.user_id = u.id
             WHERE uca.class_id = e.class_id AND u.role = 'teacher'
             ORDER BY (
               SELECT COUNT(*) FROM user_class_assignments x WHERE x.user_id = u.id
             ) ASC, u.created_at ASC
             LIMIT 1
           ) as form_teacher_name,
           (SELECT COUNT(*) FROM exam_merge_sources ems WHERE ems.exam_id = e.id) as merged_source_count
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ?
  `).get(id);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  // Get all results for this exam
  const results = db.prepare(`
    SELECT er.*, s.name as student_name, s.admission_number,
           sub.name as subject_name, sub.code as subject_code
    FROM exam_results er
    JOIN students s ON er.student_id = s.id
    JOIN subjects sub ON er.subject_id = sub.id
    WHERE er.exam_id = ?
  `).all(id);

  let componentResults = [];
  if (exam.component_exam_id) {
    componentResults = db.prepare(`
      SELECT er.*, s.name as student_name, s.admission_number,
             sub.name as subject_name, sub.code as subject_code
      FROM exam_results er
      JOIN students s ON er.student_id = s.id
      JOIN subjects sub ON er.subject_id = sub.id
      WHERE er.exam_id = ?
    `).all(exam.component_exam_id);
  }

  const mergeSources = db.prepare(`
    SELECT ems.source_exam_id as id, e.name, e.type, e.term, e.year, e.max_score
    FROM exam_merge_sources ems
    JOIN exams e ON e.id = ems.source_exam_id
    WHERE ems.exam_id = ?
    ORDER BY e.created_at ASC
  `).all(id);

  // Get students in this class
  const students = db.prepare(
    'SELECT * FROM students WHERE class_id = ? ORDER BY name ASC'
  ).all(exam.class_id);

  // Get subjects for this class
  const subjects = db.prepare(
    'SELECT * FROM subjects WHERE class_id = ? ORDER BY name ASC'
  ).all(exam.class_id);

  const subjectIdsByStudent = db.prepare(`
    SELECT ss.student_id, ss.subject_id
    FROM student_subjects ss
    JOIN students st ON st.id = ss.student_id
    JOIN subjects sub ON sub.id = ss.subject_id
    WHERE st.class_id = ? AND sub.class_id = ?
  `).all(exam.class_id, exam.class_id);
  const studentSubjectMap = new Map();
  subjectIdsByStudent.forEach((row) => {
    const list = studentSubjectMap.get(row.student_id) || [];
    list.push(row.subject_id);
    studentSubjectMap.set(row.student_id, list);
  });
  const allSubjectIds = subjects.map((subject) => subject.id);
  const hydratedStudents = students.map((student) => {
    const subject_ids = studentSubjectMap.get(student.id) || [];
    return {
      ...student,
      subject_ids: subject_ids.length ? subject_ids : allSubjectIds,
    };
  });

  // Get rankings
  const rankings = rankStudentsByExam(id);
  const subjectGradingProfiles = db.prepare(`
    SELECT subject_id, grading_system, custom_criteria, updated_at
    FROM exam_subject_grading_profiles
    WHERE exam_id = ?
  `).all(id).map((row) => ({
    subject_id: row.subject_id,
    grading_system: row.grading_system,
    custom_criteria: parseCustomCriteria(row.custom_criteria),
    updated_at: row.updated_at,
  }));

  res.json({
    exam: {
      ...exam,
      results,
      componentResults,
      mergeSources,
      students: hydratedStudents,
      subjects,
      rankings,
      subject_grading_profiles: subjectGradingProfiles,
      subject_max_scores: loadSubjectMaxScoreRows(id),
    }
  });
});

router.get('/:id/subject-grading', idValidation, (req, res) => {
  const { id } = req.params;
  const exam = db.prepare('SELECT id, class_id FROM exams WHERE id = ?').get(id);
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  const profiles = db.prepare(`
    SELECT subject_id, grading_system, custom_criteria, updated_at
    FROM exam_subject_grading_profiles
    WHERE exam_id = ?
  `).all(id).map((row) => ({
    subject_id: row.subject_id,
    grading_system: row.grading_system,
    custom_criteria: parseCustomCriteria(row.custom_criteria),
    updated_at: row.updated_at,
  }));

  res.json({ profiles });
});

router.put('/:id/subject-grading', idValidation, (req, res) => {
  const { id } = req.params;
  const { profiles } = req.body;
  const exam = db.prepare('SELECT id, class_id, lock_status, type FROM exams WHERE id = ?').get(id);
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (isMidtermExam(exam)) {
    return res.status(400).json({ error: 'Mid Term exams rank by marks only and do not use grading systems.' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;
  if (!ensureExamScoresEditable(exam, res)) return;
  if (!Array.isArray(profiles)) {
    return res.status(400).json({ error: 'profiles must be an array' });
  }

  const classSubjectIds = new Set(
    db.prepare('SELECT id FROM subjects WHERE class_id = ?').all(exam.class_id).map((row) => row.id)
  );

  const upsert = db.prepare(`
    INSERT INTO exam_subject_grading_profiles (exam_id, subject_id, grading_system, custom_criteria, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(exam_id, subject_id)
    DO UPDATE SET grading_system = excluded.grading_system, custom_criteria = excluded.custom_criteria, updated_at = CURRENT_TIMESTAMP
  `);
  const remove = db.prepare('DELETE FROM exam_subject_grading_profiles WHERE exam_id = ? AND subject_id = ?');

  const tx = db.transaction((items) => {
    const allowedGradingSystems = getAllowedGradingSystems();
    for (const item of items) {
      const subjectId = String(item?.subject_id || '').trim();
      const gradingSystem = String(item?.grading_system || '').trim();
      if (!subjectId || !classSubjectIds.has(subjectId)) {
        throw new Error(`Invalid subject_id: ${subjectId || '<empty>'}`);
      }
      if (!['custom', ...ALL_GRADING_SYSTEMS].includes(gradingSystem)) {
        throw new Error(`Invalid grading_system for subject ${subjectId}`);
      }
      if (gradingSystem !== 'custom' && !allowedGradingSystems.includes(gradingSystem)) {
        throw new Error(getUnavailableGradingMessage(gradingSystem));
      }
      if (gradingSystem !== 'custom') {
        remove.run(id, subjectId);
        continue;
      }
      const customCriteria = parseCustomCriteria(item?.custom_criteria);
      if (!Array.isArray(customCriteria) || customCriteria.length === 0) {
        throw new Error(`custom_criteria required for custom grading on subject ${subjectId}`);
      }
      upsert.run(id, subjectId, gradingSystem, JSON.stringify(customCriteria));
    }
  });

  try {
    tx(profiles);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Failed to update subject grading profiles' });
  }

  const updatedProfiles = db.prepare(`
    SELECT subject_id, grading_system, custom_criteria, updated_at
    FROM exam_subject_grading_profiles
    WHERE exam_id = ?
  `).all(id).map((row) => ({
    subject_id: row.subject_id,
    grading_system: row.grading_system,
    custom_criteria: parseCustomCriteria(row.custom_criteria),
    updated_at: row.updated_at,
  }));

  res.json({ message: 'Subject grading profiles updated', profiles: updatedProfiles });
});

// Create new exam
router.post('/', examValidation.create, (req, res, next) => {
  try {
    const {
      class_id,
      name,
      type,
      term,
      year,
      grading_system = 'normal',
      max_score = 100,
      component_exam_id = null,
      merge_exam_ids = [],
      component_weight = 0,
      current_weight = 100,
      subject_max_scores = [],
    } = req.body;

    const effectiveGradingSystem = isMidtermExam(type) ? 'normal' : grading_system;
    if (!isMidtermExam(type) && !ensureAllowedGradingSystem(effectiveGradingSystem, res)) return;

    // Verify class exists
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(class_id);
    if (!classExists) {
      return res.status(404).json({ error: 'Class not found' });
    }
    if (!ensureClassAccess(req, res, class_id)) return;

    const parsedMaxScore = Number(max_score);
    if (!Number.isFinite(parsedMaxScore) || parsedMaxScore <= 0) {
      return res.status(400).json({ error: 'Max score must be greater than 0' });
    }

    const mergeExamIds = Array.from(
      new Set((Array.isArray(merge_exam_ids) ? merge_exam_ids : []).map((id) => String(id || '').trim()).filter(Boolean))
    );
    const isMergeExam = mergeExamIds.length > 0;

    let parsedComponentWeight = Number(component_weight);
    let parsedCurrentWeight = Number(current_weight);
    let componentExamId = null;

    if (isMergeExam) {
      if (!['midterm', 'endterm'].includes(type)) {
        return res.status(400).json({ error: 'Merged exams must be Mid Term or End of Term' });
      }
      if (mergeExamIds.length < 2) {
        return res.status(400).json({ error: 'Select at least two completed tests to merge' });
      }
      parsedComponentWeight = 0;
      parsedCurrentWeight = 100;
    } else {
      if (Math.abs((parsedComponentWeight + parsedCurrentWeight) - 100) > 0.001) {
        return res.status(400).json({ error: 'Component and current weights must add up to 100' });
      }

      if (component_exam_id) {
        const componentExam = db.prepare('SELECT id, class_id FROM exams WHERE id = ?').get(component_exam_id);
        if (!componentExam) {
          return res.status(404).json({ error: 'Referenced component exam not found' });
        }
        if (componentExam.class_id !== class_id) {
          return res.status(400).json({ error: 'Referenced component exam must belong to the same class' });
        }
        componentExamId = componentExam.id;
      }
    }

    const id = uuidv4();

    const saveExam = db.transaction(() => {
      db.prepare(`
        INSERT INTO exams (id, class_id, name, type, term, year, grading_system, max_score, component_exam_id, component_weight, current_weight)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, class_id, name, type, term, year, effectiveGradingSystem, parsedMaxScore, componentExamId, parsedComponentWeight, parsedCurrentWeight);

      saveSubjectMaxScores(id, class_id, subject_max_scores);

      if (!isMergeExam) return;

      const placeholders = mergeExamIds.map(() => '?').join(', ');
      const sourceExams = db.prepare(`
        SELECT id, class_id, type
        FROM exams
        WHERE id IN (${placeholders})
      `).all(...mergeExamIds);
      if (sourceExams.length !== mergeExamIds.length) {
        throw new Error('One or more selected source tests could not be found');
      }
      if (sourceExams.some((examRow) => examRow.class_id !== class_id)) {
        throw new Error('All selected tests must belong to the selected class');
      }
      if (sourceExams.some((examRow) => examRow.type !== 'test')) {
        throw new Error('Only completed tests can be merged');
      }

      const insertMergeSource = db.prepare(`
        INSERT INTO exam_merge_sources (exam_id, source_exam_id)
        VALUES (?, ?)
      `);
      mergeExamIds.forEach((sourceExamId) => insertMergeSource.run(id, sourceExamId));

      const sourceScoreRows = db.prepare(`
        SELECT er.student_id, er.subject_id, er.score, er.exam_id as source_exam_id, e.max_score as source_max_score
        FROM exam_results er
        JOIN exams e ON e.id = er.exam_id
        WHERE er.exam_id IN (${placeholders})
      `).all(...mergeExamIds);

      if (sourceScoreRows.length === 0) {
        throw new Error('Selected tests have no recorded results to merge');
      }

      const mergedResults = buildMergedResults(sourceScoreRows, parsedMaxScore, mergeExamIds);
      const upsertResult = db.prepare(`
        INSERT INTO exam_results (exam_id, student_id, subject_id, score, grade, points)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(exam_id, student_id, subject_id)
        DO UPDATE SET score = excluded.score, grade = excluded.grade, points = excluded.points, updated_at = CURRENT_TIMESTAMP
      `);

      mergedResults.forEach((resultRow) => {
        if (isMidtermExam(type)) {
          upsertResult.run(id, resultRow.student_id, resultRow.subject_id, resultRow.score, null, null);
          return;
        }
        const graded = getGrade(resultRow.score, effectiveGradingSystem);
        upsertResult.run(id, resultRow.student_id, resultRow.subject_id, resultRow.score, graded.grade, graded.points);
      });
    });

    try {
      saveExam();
    } catch (transactionError) {
      return res.status(400).json({ error: transactionError.message || 'Failed to create merged exam' });
    }

    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);

    res.status(201).json({
      message: 'Exam created successfully',
      exam
    });
  } catch (error) {
    next(error);
  }
});

// Update exam
router.put('/:id', idValidation, (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, type, term, year, grading_system, max_score, component_exam_id, component_weight, current_weight } = req.body;

    const existing = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (type !== undefined) {
      if (!['test', 'midterm', 'endterm'].includes(type)) {
        return res.status(400).json({ error: 'Invalid exam type' });
      }
      updates.push('type = ?');
      values.push(type);
    }
    if (term !== undefined) {
      updates.push('term = ?');
      values.push(term);
    }
    if (year !== undefined) {
      updates.push('year = ?');
      values.push(year);
    }
    if (grading_system !== undefined && !isMidtermExam(existing)) {
      if (!ensureAllowedGradingSystem(grading_system, res)) return;
      updates.push('grading_system = ?');
      values.push(grading_system);
    }
    if (component_exam_id !== undefined) {
      if (component_exam_id) {
        const componentExam = db.prepare('SELECT id, class_id FROM exams WHERE id = ?').get(component_exam_id);
        if (!componentExam) {
          return res.status(404).json({ error: 'Referenced component exam not found' });
        }
        if (componentExam.class_id !== existing.class_id) {
          return res.status(400).json({ error: 'Referenced component exam must belong to the same class' });
        }
      }
      updates.push('component_exam_id = ?');
      values.push(component_exam_id || null);
    }
    if (component_weight !== undefined) {
      const parsed = Number(component_weight);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return res.status(400).json({ error: 'Component weight must be between 0 and 100' });
      }
      updates.push('component_weight = ?');
      values.push(parsed);
    }
    if (current_weight !== undefined) {
      const parsed = Number(current_weight);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return res.status(400).json({ error: 'Current weight must be between 0 and 100' });
      }
      updates.push('current_weight = ?');
      values.push(parsed);
    }
    if (max_score !== undefined) {
      const parsed = Number(max_score);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'Max score must be greater than 0' });
      }
      updates.push('max_score = ?');
      values.push(parsed);
    }

    const nextComponentWeight = component_weight !== undefined ? Number(component_weight) : Number(existing.component_weight || 0);
    const nextCurrentWeight = current_weight !== undefined ? Number(current_weight) : Number(existing.current_weight || 100);
    if (Math.abs((nextComponentWeight + nextCurrentWeight) - 100) > 0.001) {
      return res.status(400).json({ error: 'Component and current weights must add up to 100' });
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);
      db.prepare(`UPDATE exams SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);

    res.json({
      message: 'Exam updated successfully',
      exam
    });
  } catch (error) {
    next(error);
  }
});

// Delete exam
router.delete('/:id', idValidation, (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (!ensureClassAccess(req, res, existing.class_id)) return;

    db.prepare('DELETE FROM exams WHERE id = ?').run(id);

    res.json({ message: 'Exam deleted successfully' });
  } catch (error) {
    next(error);
  }
});

router.put('/:id/lock', idValidation, (req, res) => {
  const { id } = req.params;
  const { lock_type } = req.body;
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Only admins can lock exams' });
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  const nextLock = String(lock_type || '').toLowerCase();
  if (!['temporary', 'permanent'].includes(nextLock)) {
    return res.status(400).json({ error: 'lock_type must be temporary or permanent' });
  }

  const currentStatus = normalizeLockStatus(exam);
  if (currentStatus === 'permanent') {
    return res.status(400).json({ error: 'Exam is permanently locked and cannot be changed' });
  }

  db.prepare(`
    UPDATE exams
    SET lock_status = ?, locked_at = CURRENT_TIMESTAMP, locked_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextLock, req.user.id, id);

  const updated = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  res.json({ message: `Exam ${nextLock} lock applied`, exam: updated });
});

router.put('/:id/unlock', idValidation, (req, res) => {
  const { id } = req.params;
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Only admins can unlock exams' });
  }

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  const currentStatus = normalizeLockStatus(exam);
  if (currentStatus === 'permanent') {
    return res.status(400).json({ error: 'Exam is permanently locked and cannot be unlocked' });
  }
  if (currentStatus === 'none') {
    return res.json({ message: 'Exam is already unlocked', exam });
  }

  db.prepare(`
    UPDATE exams
    SET lock_status = 'none', locked_at = NULL, locked_by = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  const updated = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  res.json({ message: 'Exam unlocked', exam: updated });
});

// Add or update exam result
router.post('/:id/results', examValidation.addResult, (req, res, next) => {
  try {
    const { id: exam_id } = req.params;
    const { results } = req.body;

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: "Results must be a non-empty array" });
    }

    // Get exam
    const exam = db.prepare(
      "SELECT id, class_id, type, grading_system, max_score, lock_status FROM exams WHERE id = ?"
    ).get(exam_id);

    if (!exam) {
      return res.status(404).json({ error: "Exam not found" });
    }
    if (!ensureClassAccess(req, res, exam.class_id)) return;
    if (!ensureExamScoresEditable(exam, res)) return;

    const insert = db.prepare(`
      INSERT INTO exam_results (exam_id, student_id, subject_id, score, grade, points)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(exam_id, student_id, subject_id)
      DO UPDATE SET score = ?, grade = ?, points = ?, updated_at = CURRENT_TIMESTAMP
    `);

    const getStudent = db.prepare(
      "SELECT id, class_id FROM students WHERE id = ?"
    );

    const getSubject = db.prepare(
      "SELECT id, class_id FROM subjects WHERE id = ?"
    );
    const isStudentEnrolledInSubject = db.prepare(`
      SELECT 1
      FROM student_subjects ss
      WHERE ss.student_id = ? AND ss.subject_id = ?
      LIMIT 1
    `);

    const saved = [];
    const profileMap = loadSubjectProfileMap(exam_id);

    const examMaxScore = Number(exam.max_score || 100);
    for (const row of results) {
      const { student_id, subject_id, score } = row;
      const numericScore = Number(score);
      if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > examMaxScore) {
        return res.status(400).json({ error: `Score must be between 0 and ${examMaxScore}` });
      }
      const roundedScore = Math.round(numericScore);

      const student = getStudent.get(student_id);
      if (!student) {
        return res.status(400).json({ error: `Student ${student_id} does not exist` });
      }
      if (student.class_id !== exam.class_id) {
        return res.status(400).json({ error: `Student ${student_id} not in this class` });
      }

      const subject = getSubject.get(subject_id);
      if (!subject) {
        return res.status(400).json({ error: `Subject ${subject_id} does not exist` });
      }
      if (subject.class_id !== exam.class_id) {
        return res.status(400).json({ error: `Subject ${subject_id} not in this class` });
      }
      const isEnrolled = isStudentEnrolledInSubject.get(student_id, subject_id);
      if (!isEnrolled) {
        return res.status(400).json({ error: `Student ${student_id} is not assigned to subject ${subject_id}` });
      }

      const subjectGrading = resolveSubjectGrading(profileMap, subject_id, exam.grading_system);
      const gradeFields = isMidtermExam(exam)
        ? { grade: null, points: null }
        : getGrade(roundedScore, subjectGrading.gradingSystem, subjectGrading.customCriteria);

      insert.run(
        exam_id, student_id, subject_id, roundedScore, gradeFields.grade, gradeFields.points,
        roundedScore, gradeFields.grade, gradeFields.points
      );

      const result = db.prepare(`
        SELECT * FROM exam_results
        WHERE exam_id = ? AND student_id = ? AND subject_id = ?
      `).get(exam_id, student_id, subject_id);

      saved.push(result);
    }

    res.json({
      message: "Results saved successfully",
      results: saved
    });

  } catch (error) {
    next(error);
  }
});


// Bulk add results
router.post('/:id/results/bulk', authenticateToken, (req, res, next) => {
  try {
    const { id: exam_id } = req.params;
    const { results } = req.body;

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'Results array required' });
    }

    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(exam_id);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (!ensureClassAccess(req, res, exam.class_id)) return;
    if (!ensureExamScoresEditable(exam, res)) return;

    const upsert = db.prepare(`
      INSERT INTO exam_results (exam_id, student_id, subject_id, score, grade, points)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(exam_id, student_id, subject_id) 
      DO UPDATE SET score = ?, grade = ?, points = ?, updated_at = CURRENT_TIMESTAMP
    `);
    const getStudent = db.prepare('SELECT id, class_id FROM students WHERE id = ?');
    const getSubject = db.prepare('SELECT id, class_id FROM subjects WHERE id = ?');
    const isStudentEnrolledInSubject = db.prepare(`
      SELECT 1 FROM student_subjects WHERE student_id = ? AND subject_id = ? LIMIT 1
    `);

    const profileMap = loadSubjectProfileMap(exam_id);
    const insertMany = db.transaction((results) => {
      let saved = 0;
      let errors = [];

      for (const r of results) {
        if (!r.student_id || !r.subject_id || r.score === undefined) {
          errors.push({ ...r, reason: 'Missing required fields' });
          continue;
        }
        const student = getStudent.get(r.student_id);
        if (!student || student.class_id !== exam.class_id) {
          errors.push({ ...r, reason: 'Student not in this class' });
          continue;
        }
        const subject = getSubject.get(r.subject_id);
        if (!subject || subject.class_id !== exam.class_id) {
          errors.push({ ...r, reason: 'Subject not in this class' });
          continue;
        }
        if (!isStudentEnrolledInSubject.get(r.student_id, r.subject_id)) {
          errors.push({ ...r, reason: 'Student is not assigned to this subject' });
          continue;
        }

        const score = parseFloat(r.score);
        const examMaxScore = Number(exam.max_score || 100);
        if (isNaN(score) || score < 0 || score > examMaxScore) {
          errors.push({ ...r, reason: `Invalid score (allowed range: 0-${examMaxScore})` });
          continue;
        }

        const roundedScore = Math.round(score);
        const subjectGrading = resolveSubjectGrading(profileMap, r.subject_id, exam.grading_system);
        const gradeFields = isMidtermExam(exam)
          ? { grade: null, points: null }
          : getGrade(roundedScore, subjectGrading.gradingSystem, subjectGrading.customCriteria);
        upsert.run(exam_id, r.student_id, r.subject_id, roundedScore, gradeFields.grade, gradeFields.points, roundedScore, gradeFields.grade, gradeFields.points);
        saved++;
      }

      return { saved, errors };
    });

    const result = insertMany(results);

    res.json({
      message: `Saved ${result.saved} results`,
      saved: result.saved,
      errors: result.errors.length,
      errorDetails: result.errors
    });
  } catch (error) {
    next(error);
  }
});

// Get rankings for exam
router.get('/:id/rankings', idValidation, (req, res) => {
  const { id } = req.params;

  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  const rankings = rankStudentsByExam(id);

  res.json({ rankings });
});

// Get grade criteria
router.get('/criteria/:system', (req, res) => {
  const { system } = req.params;
  
  if (!ensureAllowedGradingSystem(system, res)) return;

  const criteria = getGradeCriteria(system);
  res.json({ criteria });
});

// Update grade criteria
router.put('/criteria/:system', authenticateToken, (req, res, next) => {
  try {
    const { system } = req.params;
    const { criteria } = req.body;

    if (!ensureAllowedGradingSystem(system, res)) return;

    if (!Array.isArray(criteria)) {
      return res.status(400).json({ error: 'Criteria array required' });
    }

    // Delete existing and insert new
    const deleteCriteria = db.prepare('DELETE FROM grade_criteria WHERE system = ?');
    const insertCriteria = db.prepare(`
      INSERT INTO grade_criteria (grade, min_score, max_score, points, remark, system)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const updateAll = db.transaction((criteria, system) => {
      deleteCriteria.run(system);
      for (const c of criteria) {
        insertCriteria.run(c.grade, c.min_score, c.max_score, c.points || null, c.remark, system);
      }
    });

    updateAll(criteria, system);

    const updated = getGradeCriteria(system);
    res.json({ message: 'Criteria updated successfully', criteria: updated });
  } catch (error) {
    next(error);
  }
});

export default router;
