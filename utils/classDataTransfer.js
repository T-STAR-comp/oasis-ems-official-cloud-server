import db from '../db/database.js';

const CLASS_SCOPED_TABLES = [
  'classes',
  'students',
  'subjects',
  'student_subjects',
  'exams',
  'exam_results',
  'exam_subject_grading_profiles',
  'exam_merge_sources',
  'promotion_criteria',
  'promotion_actions',
  'conduct_incidents',
  'timetable_entries',
  'attendance_records',
];

function getClassExamIds(classId) {
  return db.prepare('SELECT id FROM exams WHERE class_id = ?').all(classId).map((row) => row.id);
}

function getClassStudentIds(classId) {
  return db.prepare('SELECT id FROM students WHERE class_id = ?').all(classId).map((row) => row.id);
}

function getClassSubjectIds(classId) {
  return db.prepare('SELECT id FROM subjects WHERE class_id = ?').all(classId).map((row) => row.id);
}

export function exportClassData(classId) {
  const classRow = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!classRow) {
    throw new Error('Class not found.');
  }

  const studentIds = getClassStudentIds(classId);
  const subjectIds = getClassSubjectIds(classId);
  const examIds = getClassExamIds(classId);

  const students = studentIds.length
    ? db.prepare(`SELECT * FROM students WHERE class_id = ?`).all(classId)
    : [];

  const subjects = subjectIds.length
    ? db.prepare(`SELECT * FROM subjects WHERE class_id = ?`).all(classId)
    : [];

  const studentSubjects = studentIds.length && subjectIds.length
    ? db.prepare(`
      SELECT * FROM student_subjects
      WHERE student_id IN (${studentIds.map(() => '?').join(',')})
    `).all(...studentIds)
    : [];

  const exams = examIds.length
    ? db.prepare(`SELECT * FROM exams WHERE class_id = ?`).all(classId)
    : [];

  const examResults = examIds.length
    ? db.prepare(`
      SELECT * FROM exam_results
      WHERE exam_id IN (${examIds.map(() => '?').join(',')})
    `).all(...examIds)
    : [];

  const examSubjectProfiles = examIds.length
    ? db.prepare(`
      SELECT * FROM exam_subject_grading_profiles
      WHERE exam_id IN (${examIds.map(() => '?').join(',')})
    `).all(...examIds)
    : [];

  const examMergeSources = examIds.length
    ? db.prepare(`
      SELECT * FROM exam_merge_sources
      WHERE exam_id IN (${examIds.map(() => '?').join(',')})
        OR source_exam_id IN (${examIds.map(() => '?').join(',')})
    `).all(...examIds, ...examIds)
    : [];

  const promotionCriteria = db.prepare('SELECT * FROM promotion_criteria WHERE class_id = ?').all(classId);
  const promotionActions = db.prepare('SELECT * FROM promotion_actions WHERE class_id = ?').all(classId);

  const conductIncidents = db.prepare('SELECT * FROM conduct_incidents WHERE class_id = ?').all(classId);
  const timetableEntries = db.prepare('SELECT * FROM timetable_entries WHERE class_id = ?').all(classId);
  const attendanceRecords = db.prepare('SELECT * FROM attendance_records WHERE class_id = ?').all(classId);

  return {
    schema_version: '1.0',
    exported_at: new Date().toISOString(),
    source_class_id: classId,
    data: {
      classes: [classRow],
      students,
      subjects,
      student_subjects: studentSubjects,
      exams,
      exam_results: examResults,
      exam_subject_grading_profiles: examSubjectProfiles,
      exam_merge_sources: examMergeSources,
      promotion_criteria: promotionCriteria,
      promotion_actions: promotionActions,
      conduct_incidents: conductIncidents,
      timetable_entries: timetableEntries,
      attendance_records: attendanceRecords,
    },
  };
}

function insertRows(table, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const tableColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const insertColumns = Object.keys(rows[0]).filter((column) => tableColumns.includes(column));
  if (!insertColumns.length) return 0;

  const placeholders = insertColumns.map(() => '?').join(', ');
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ${table} (${insertColumns.join(', ')})
    VALUES (${placeholders})
  `);
  rows.forEach((row) => {
    stmt.run(...insertColumns.map((column) => row[column]));
  });
  return rows.length;
}

export function importClassData(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid class import payload.');
  }

  const classRows = Array.isArray(data.classes) ? data.classes : [];
  if (!classRows.length) {
    throw new Error('Import file does not contain a class record.');
  }

  const tx = db.transaction((importData) => {
    const order = [
      'classes',
      'students',
      'subjects',
      'student_subjects',
      'exams',
      'exam_subject_grading_profiles',
      'exam_merge_sources',
      'exam_results',
      'promotion_criteria',
      'promotion_actions',
      'conduct_incidents',
      'timetable_entries',
      'attendance_records',
    ];

    let imported = {};
    order.forEach((table) => {
      imported[table] = insertRows(table, importData[table]);
    });
    return imported;
  });

  return tx(data);
}
