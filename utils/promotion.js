import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { calculateStudentResults, formatRank, rankStudentsByExam } from './grading.js';

export const PROMOTION_RULE_MODES = [
  'auto_all',
  'pass_all_exams',
  'pass_selected_exams',
  'average_midterm_endterm',
  'average_endterm_only',
];

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function roundScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : null;
}

export function getDefaultAcademicYear(classId) {
  const row = db.prepare(`
    SELECT year
    FROM exams
    WHERE class_id = ?
    ORDER BY year DESC, created_at DESC
    LIMIT 1
  `).get(classId);
  if (row?.year) return String(row.year);
  return String(new Date().getFullYear());
}

export function normalizeCriteriaRow(row, classId) {
  if (!row) {
    return {
      class_id: classId,
      rule_mode: 'pass_all_exams',
      next_class_id: null,
      academic_year: getDefaultAcademicYear(classId),
      minimum_average: 50,
      minimum_pass_score: 50,
      selected_exam_ids: [],
    };
  }

  return {
    class_id: classId,
    rule_mode: PROMOTION_RULE_MODES.includes(row.rule_mode) ? row.rule_mode : 'pass_all_exams',
    next_class_id: row.next_class_id || null,
    academic_year: String(row.academic_year || getDefaultAcademicYear(classId)),
    minimum_average: Number(row.minimum_average ?? 50),
    minimum_pass_score: Number(row.minimum_pass_score ?? 50),
    selected_exam_ids: parseJsonArray(row.selected_exam_ids),
  };
}

export function getPromotionCriteria(classId) {
  const row = db.prepare('SELECT * FROM promotion_criteria WHERE class_id = ?').get(classId);
  return normalizeCriteriaRow(row, classId);
}

export function savePromotionCriteria(classId, payload = {}) {
  const current = getPromotionCriteria(classId);
  const next = {
    ...current,
    ...payload,
    class_id: classId,
    rule_mode: PROMOTION_RULE_MODES.includes(payload.rule_mode) ? payload.rule_mode : current.rule_mode,
    selected_exam_ids: Array.isArray(payload.selected_exam_ids)
      ? payload.selected_exam_ids
      : current.selected_exam_ids,
  };

  if (next.next_class_id) {
    const target = db.prepare('SELECT id FROM classes WHERE id = ?').get(next.next_class_id);
    if (!target) {
      throw new Error('Selected next class was not found.');
    }
    if (next.next_class_id === classId) {
      throw new Error('Next class must be different from the current class.');
    }
  }

  db.prepare(`
    INSERT INTO promotion_criteria (
      class_id, rule_mode, next_class_id, academic_year,
      minimum_average, minimum_pass_score, selected_exam_ids, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(class_id) DO UPDATE SET
      rule_mode = excluded.rule_mode,
      next_class_id = excluded.next_class_id,
      academic_year = excluded.academic_year,
      minimum_average = excluded.minimum_average,
      minimum_pass_score = excluded.minimum_pass_score,
      selected_exam_ids = excluded.selected_exam_ids,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    classId,
    next.rule_mode,
    next.next_class_id,
    next.academic_year,
    next.minimum_average,
    next.minimum_pass_score,
    JSON.stringify(next.selected_exam_ids || []),
  );

  return getPromotionCriteria(classId);
}

function getClassExams(classId, academicYear, { types = null, examIds = null } = {}) {
  let query = `
    SELECT id, name, type, term, year, class_id, created_at
    FROM exams
    WHERE class_id = ? AND year = ?
  `;
  const params = [classId, academicYear];

  if (Array.isArray(types) && types.length) {
    query += ` AND type IN (${types.map(() => '?').join(', ')})`;
    params.push(...types);
  }

  if (Array.isArray(examIds) && examIds.length) {
    query += ` AND id IN (${examIds.map(() => '?').join(', ')})`;
    params.push(...examIds);
  }

  query += ' ORDER BY CASE type WHEN \'endterm\' THEN 0 WHEN \'midterm\' THEN 1 ELSE 2 END, term ASC, created_at ASC';
  return db.prepare(query).all(...params);
}

function studentPassesExam(studentId, examId, minimumPassScore) {
  const summary = calculateStudentResults(examId, studentId);
  if (!summary.subjectCount) {
    return { passed: false, average: null, subjectCount: 0 };
  }

  const failedSubject = summary.results.find(
    (row) => Number(row.score) < minimumPassScore,
  );
  const average = roundScore(summary.averageScore);
  const passed = !failedSubject && average !== null && average >= minimumPassScore;
  return { passed, average, subjectCount: summary.subjectCount };
}

function getExamRankForStudent(examId, studentId) {
  const rankings = rankStudentsByExam(examId);
  const match = rankings.find((row) => row.student?.id === studentId || row.student_id === studentId);
  return match ? formatRank(match.rank) : '—';
}

function resolveRelevantExams(criteria) {
  switch (criteria.rule_mode) {
    case 'pass_selected_exams':
      return getClassExams(criteria.class_id, criteria.academic_year, {
        examIds: criteria.selected_exam_ids,
      });
    case 'average_midterm_endterm':
      return getClassExams(criteria.class_id, criteria.academic_year, {
        types: ['midterm', 'endterm'],
      });
    case 'average_endterm_only':
      return getClassExams(criteria.class_id, criteria.academic_year, {
        types: ['endterm'],
      });
    case 'pass_all_exams':
      return getClassExams(criteria.class_id, criteria.academic_year);
    default:
      return [];
  }
}

function evaluateEligibility(studentId, criteria, exams) {
  if (criteria.rule_mode === 'auto_all') {
    return {
      eligible: true,
      reason: 'Automatic promotion is enabled for this class.',
      exam_summaries: [],
      combined_average: null,
    };
  }

  if (!exams.length) {
    return {
      eligible: false,
      reason: 'No exams match the selected promotion rule for this academic year.',
      exam_summaries: [],
      combined_average: null,
    };
  }

  const examSummaries = exams.map((exam) => {
    const result = studentPassesExam(studentId, exam.id, criteria.minimum_pass_score);
    return {
      exam_id: exam.id,
      exam_name: exam.name,
      exam_type: exam.type,
      term: exam.term,
      average: result.average,
      position: getExamRankForStudent(exam.id, studentId),
      passed: result.passed,
      subject_count: result.subjectCount,
    };
  });

  if (criteria.rule_mode === 'pass_all_exams' || criteria.rule_mode === 'pass_selected_exams') {
    const failed = examSummaries.filter((row) => !row.passed);
    return {
      eligible: failed.length === 0,
      reason: failed.length
        ? `Did not meet the pass requirement in ${failed.length} exam(s).`
        : 'Passed all required exams.',
      exam_summaries: examSummaries,
      combined_average: roundScore(
        examSummaries.reduce((sum, row) => sum + Number(row.average || 0), 0) / Math.max(examSummaries.length, 1),
      ),
    };
  }

  const averages = examSummaries
    .map((row) => row.average)
    .filter((value) => value !== null);
  const combinedAverage = averages.length
    ? roundScore(averages.reduce((sum, value) => sum + value, 0) / averages.length)
    : null;
  const eligible = combinedAverage !== null && combinedAverage >= criteria.minimum_average;

  return {
    eligible,
    reason: eligible
      ? `Combined average ${combinedAverage}% meets the minimum ${criteria.minimum_average}%.`
      : combinedAverage === null
        ? 'No exam averages recorded for this student.'
        : `Combined average ${combinedAverage}% is below the minimum ${criteria.minimum_average}%.`,
    exam_summaries: examSummaries,
    combined_average: combinedAverage,
  };
}

export function buildClassPromotionPreview(classId) {
  const criteria = getPromotionCriteria(classId);
  const classRoom = db.prepare('SELECT id, name, year FROM classes WHERE id = ?').get(classId);
  if (!classRoom) {
    throw new Error('Class not found.');
  }

  const exams = resolveRelevantExams(criteria);
  const allClassExams = getClassExams(classId, criteria.academic_year);
  const students = db.prepare(`
    SELECT id, name, admission_number, gender, class_id
    FROM students
    WHERE class_id = ?
    ORDER BY name ASC
  `).all(classId);

  const nextClass = criteria.next_class_id
    ? db.prepare('SELECT id, name, year FROM classes WHERE id = ?').get(criteria.next_class_id)
    : null;

  const studentRows = students.map((student) => {
    const evaluation = evaluateEligibility(student.id, criteria, exams);
    return {
      ...student,
      eligible: evaluation.eligible,
      eligibility_reason: evaluation.reason,
      combined_average: evaluation.combined_average,
      exams: evaluation.exam_summaries,
    };
  });

  return {
    class: classRoom,
    criteria,
    next_class: nextClass,
    academic_year: criteria.academic_year,
    available_exams: allClassExams,
    relevant_exams: exams,
    students: studentRows,
    summary: {
      total_students: studentRows.length,
      eligible_count: studentRows.filter((row) => row.eligible).length,
      ineligible_count: studentRows.filter((row) => !row.eligible).length,
    },
  };
}

function moveStudents(moves) {
  const update = db.prepare(`
    UPDATE students
    SET class_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const tx = db.transaction((items) => {
    items.forEach((move) => {
      update.run(move.to_class_id, move.student_id);
    });
  });
  tx(moves);
}

export function recordPromotionAction({
  actionType,
  classId,
  academicYear,
  criteriaSnapshot,
  studentMoves,
  performedBy,
}) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO promotion_actions (
      id, action_type, class_id, academic_year, criteria_snapshot,
      student_moves, performed_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    actionType,
    classId || null,
    academicYear || null,
    criteriaSnapshot ? JSON.stringify(criteriaSnapshot) : null,
    JSON.stringify(studentMoves),
    performedBy || null,
  );
  return getPromotionAction(id);
}

export function getPromotionAction(actionId) {
  const row = db.prepare('SELECT * FROM promotion_actions WHERE id = ?').get(actionId);
  if (!row) return null;
  return {
    ...row,
    undone: Number(row.undone || 0) === 1,
    criteria_snapshot: row.criteria_snapshot ? JSON.parse(row.criteria_snapshot) : null,
    student_moves: parseJsonArray(row.student_moves),
  };
}

export function listPromotionActions(limit = 20) {
  return db.prepare(`
    SELECT id, action_type, class_id, academic_year, student_moves, performed_by,
           undone, undone_at, undone_by, created_at
    FROM promotion_actions
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    ...row,
    undone: Number(row.undone || 0) === 1,
    student_moves: parseJsonArray(row.student_moves),
    student_count: parseJsonArray(row.student_moves).length,
  }));
}

export function applyCriteriaPromotions(classId, performedBy) {
  const preview = buildClassPromotionPreview(classId);
  const { criteria, next_class: nextClass } = preview;

  if (!nextClass?.id) {
    throw new Error('Set the next class before applying promotions.');
  }

  const eligibleStudents = preview.students.filter((student) => student.eligible);
  if (!eligibleStudents.length) {
    throw new Error('No students are eligible for promotion under the current rules.');
  }

  const moves = eligibleStudents.map((student) => ({
    student_id: student.id,
    student_name: student.name,
    from_class_id: classId,
    to_class_id: nextClass.id,
  }));

  moveStudents(moves);
  return recordPromotionAction({
    actionType: 'apply_criteria',
    classId,
    academicYear: criteria.academic_year,
    criteriaSnapshot: criteria,
    studentMoves: moves,
    performedBy,
  });
}

export function manualPromoteStudents({ studentIds, toClassId, fromClassId, performedBy }) {
  const ids = Array.isArray(studentIds) ? [...new Set(studentIds.filter(Boolean))] : [];
  if (!ids.length) {
    throw new Error('Select at least one student to promote.');
  }

  const targetClass = db.prepare('SELECT id, name, year FROM classes WHERE id = ?').get(toClassId);
  if (!targetClass) {
    throw new Error('Target class was not found.');
  }

  const moves = [];
  ids.forEach((studentId) => {
    const student = db.prepare('SELECT id, name, class_id FROM students WHERE id = ?').get(studentId);
    if (!student) return;
    if (fromClassId && student.class_id !== fromClassId) {
      throw new Error(`Student ${student.name} is not in the selected class.`);
    }
    if (student.class_id === toClassId) {
      throw new Error(`Student ${student.name} is already in the target class.`);
    }
    moves.push({
      student_id: student.id,
      student_name: student.name,
      from_class_id: student.class_id,
      to_class_id: toClassId,
    });
  });

  if (!moves.length) {
    throw new Error('No valid students were selected for promotion.');
  }

  moveStudents(moves);
  return recordPromotionAction({
    actionType: 'manual_promote',
    classId: fromClassId || moves[0].from_class_id,
    academicYear: null,
    criteriaSnapshot: null,
    studentMoves: moves,
    performedBy,
  });
}

export function manualDemoteStudent({ studentId, toClassId, performedBy }) {
  const student = db.prepare('SELECT id, name, class_id FROM students WHERE id = ?').get(studentId);
  if (!student) {
    throw new Error('Student not found.');
  }

  const targetClass = db.prepare('SELECT id FROM classes WHERE id = ?').get(toClassId);
  if (!targetClass) {
    throw new Error('Target class was not found.');
  }
  if (student.class_id === toClassId) {
    throw new Error('Student is already in the selected class.');
  }

  const move = {
    student_id: student.id,
    student_name: student.name,
    from_class_id: student.class_id,
    to_class_id: toClassId,
  };
  moveStudents([move]);

  return recordPromotionAction({
    actionType: 'manual_demote',
    classId: student.class_id,
    academicYear: null,
    criteriaSnapshot: null,
    studentMoves: [move],
    performedBy,
  });
}

export function undoPromotionAction(actionId, undoneBy) {
  const action = getPromotionAction(actionId);
  if (!action) {
    throw new Error('Promotion action not found.');
  }
  if (action.undone) {
    throw new Error('This promotion action has already been undone.');
  }

  const reverseMoves = action.student_moves.map((move) => ({
    student_id: move.student_id,
    to_class_id: move.from_class_id,
  }));

  moveStudents(reverseMoves);
  db.prepare(`
    UPDATE promotion_actions
    SET undone = 1,
        undone_at = CURRENT_TIMESTAMP,
        undone_by = ?
    WHERE id = ?
  `).run(undoneBy || null, actionId);

  return getPromotionAction(actionId);
}

export function listPromotionClasses() {
  const classes = db.prepare(`
    SELECT c.id, c.name, c.year,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
    FROM classes c
    ORDER BY c.year DESC, c.name ASC
  `).all();

  return classes.map((classRoom) => {
    const criteria = getPromotionCriteria(classRoom.id);
    const preview = buildClassPromotionPreview(classRoom.id);
    return {
      ...classRoom,
      student_count: Number(classRoom.student_count || 0),
      criteria,
      eligible_count: preview.summary.eligible_count,
      next_class_id: criteria.next_class_id,
    };
  });
}
