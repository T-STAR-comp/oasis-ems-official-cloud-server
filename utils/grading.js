import db from '../db/database.js';
import { getFallbackGrade, isPointBasedSystem } from './education.js';

function normalizeCriteria(rows = []) {
  return rows
    .map((row) => ({
      grade: String(row.grade ?? ''),
      min_score: Number(row.min_score),
      max_score: Number(row.max_score),
      points: row.points === null || row.points === undefined ? null : Number(row.points),
      remark: String(row.remark ?? ''),
    }))
    .filter((row) => Number.isFinite(row.min_score) && Number.isFinite(row.max_score))
    .sort((a, b) => b.min_score - a.min_score);
}

function defaultFallback(system) {
  if (isPointBasedSystem(system)) {
    return getFallbackGrade(system);
  }
  return getFallbackGrade(system);
}

export function normalizeGradeScore(score) {
  const numericScore = Number(score);
  return Number.isFinite(numericScore) ? Math.round(numericScore) : numericScore;
}

export function getGradeCriteria(system = 'normal', customCriteria = null) {
  if (system === 'custom') {
    return normalizeCriteria(Array.isArray(customCriteria) ? customCriteria : []);
  }
  return normalizeCriteria(
    db.prepare(`
      SELECT grade, min_score, max_score, points, remark
      FROM grade_criteria
      WHERE system = ?
      ORDER BY min_score DESC
    `).all(system)
  );
}

export function getGrade(score, system = 'normal', customCriteria = null) {
  const gradeScore = normalizeGradeScore(score);
  const criteria = getGradeCriteria(system, customCriteria);
  for (const c of criteria) {
    if (gradeScore >= c.min_score && gradeScore <= c.max_score) {
      return {
        grade: c.grade,
        points: c.points,
        remark: c.remark,
      };
    }
  }
  return defaultFallback(system);
}

function loadExamSubjectProfiles(examId) {
  const rows = db.prepare(`
    SELECT exam_id, subject_id, grading_system, custom_criteria
    FROM exam_subject_grading_profiles
    WHERE exam_id = ?
  `).all(examId);
  const map = new Map();
  rows.forEach((row) => {
    let parsedCriteria = null;
    if (row.custom_criteria) {
      try {
        parsedCriteria = JSON.parse(row.custom_criteria);
      } catch (_error) {
        parsedCriteria = null;
      }
    }
    map.set(row.subject_id, {
      gradingSystem: row.grading_system,
      customCriteria: Array.isArray(parsedCriteria) ? parsedCriteria : null,
    });
  });
  return map;
}

function loadExamSubjectMaxScores(examId) {
  const rows = db.prepare(`
    SELECT subject_id, max_score
    FROM exam_subject_max_scores
    WHERE exam_id = ?
  `).all(examId);
  const map = new Map();
  rows.forEach((row) => map.set(row.subject_id, Number(row.max_score)));
  return map;
}

export function getSubjectMaxScore(maxScoreMap, subjectId, examMaxScore = 100) {
  const configured = maxScoreMap.get(subjectId);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return Math.max(1, Number(examMaxScore) || 100);
}

export function normalizeSubjectScoreForGrading(rawScore, subjectMaxScore) {
  const raw = Number(rawScore);
  const max = Math.max(1, Number(subjectMaxScore) || 100);
  if (!Number.isFinite(raw)) return 0;
  return Number(((raw / max) * 100).toFixed(2));
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

function customCriteriaSupportsPointRanking(criteria = null) {
  return Array.isArray(criteria)
    && criteria.length > 0
    && criteria.every((row) => Number.isFinite(Number(row?.points)));
}

function isSubjectPointBased(subjectGrading) {
  if (!subjectGrading) return false;
  if (subjectGrading.gradingSystem === 'custom') {
    return customCriteriaSupportsPointRanking(subjectGrading.customCriteria);
  }
  return isPointBasedSystem(subjectGrading.gradingSystem);
}

function hasPointBasedResults(results = []) {
  if (!results.length) return false;
  return results.every(
    (row) => row.point_based === true && Number.isFinite(Number(row.points))
  );
}

function isEnglishSubject(row) {
  const code = String(row?.subject_code || '').trim().toUpperCase();
  const name = String(row?.subject_name || '').trim().toLowerCase();
  return code === 'ENG' || code === 'ENGLISH' || name === 'english' || name === 'english language';
}

export function isMidtermExamType(type) {
  return String(type || '').toLowerCase() === 'midterm';
}

function buildMidtermResultRow(baseRow, score) {
  return {
    ...baseRow,
    score,
    grading_system: null,
    point_based: false,
    grade: null,
    points: null,
    remark: null,
  };
}

function calculateBestSixPoints(results = []) {
  const rows = (results || []).filter((row) => Number.isFinite(Number(row.points)));
  if (!rows.length) return null;
  const english = rows.find(isEnglishSubject) || null;
  const others = rows.filter((row) => !isEnglishSubject(row)).sort((a, b) => Number(a.points) - Number(b.points));
  const selected = english ? [english, ...others.slice(0, 5)] : others.slice(0, 6);
  if (!selected.length) return null;
  return selected.reduce((sum, row) => sum + Number(row.points || 0), 0);
}

export function calculateStudentResults(examId, studentId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) {
    return { results: [], totalScore: 0, averageScore: 0, subjectCount: 0 };
  }
  const componentExam = exam.component_exam_id
    ? db.prepare('SELECT id, max_score FROM exams WHERE id = ?').get(exam.component_exam_id)
    : null;
  const profileMap = loadExamSubjectProfiles(examId);
  const subjectMaxScoreMap = loadExamSubjectMaxScores(examId);
  const isMidterm = isMidtermExamType(exam.type);

  const currentRows = db.prepare(`
    SELECT er.*, s.name as subject_name, s.code as subject_code
    FROM exam_results er
    JOIN subjects s ON er.subject_id = s.id
    JOIN student_subjects ss ON ss.subject_id = er.subject_id AND ss.student_id = ?
    WHERE er.exam_id = ? AND er.student_id = ?
  `).all(studentId, examId, studentId);

  const hasComponent = !!exam.component_exam_id;
  if (!hasComponent) {
    const results = currentRows.map((row) => {
      if (isMidterm) {
        return buildMidtermResultRow(row, row.score);
      }
      const subjectGrading = resolveSubjectGrading(profileMap, row.subject_id, exam.grading_system);
      const subjectMaxScore = getSubjectMaxScore(subjectMaxScoreMap, row.subject_id, exam.max_score);
      const gradeScore = normalizeSubjectScoreForGrading(row.score, subjectMaxScore);
      const gradeInfo = getGrade(gradeScore, subjectGrading.gradingSystem, subjectGrading.customCriteria);
      const pointBased = isSubjectPointBased(subjectGrading);
      return {
        ...row,
        subject_max_score: subjectMaxScore,
        grading_system: subjectGrading.gradingSystem,
        point_based: pointBased,
        grade: gradeInfo.grade,
        points: gradeInfo.points,
        remark: gradeInfo.remark,
      };
    });

    const totalScore = results.reduce((sum, r) => sum + Number(r.score || 0), 0);
    const averageScore = results.length > 0 ? totalScore / results.length : 0;
    return {
      results,
      totalScore,
      averageScore,
      subjectCount: results.length,
    };
  }

  const componentMaxScoreMap = exam.component_exam_id
    ? loadExamSubjectMaxScores(exam.component_exam_id)
    : new Map();
  const componentRows = db.prepare(`
    SELECT er.*, s.name as subject_name, s.code as subject_code
    FROM exam_results er
    JOIN subjects s ON er.subject_id = s.id
    JOIN student_subjects ss ON ss.subject_id = er.subject_id AND ss.student_id = ?
    WHERE er.exam_id = ? AND er.student_id = ?
  `).all(studentId, exam.component_exam_id, studentId);

  const currentWeight = Number(exam.current_weight ?? 100);
  const componentWeight = Number(exam.component_weight ?? 0);
  const componentExamMax = Math.max(1, Number(componentExam?.max_score || 100));
  const currentExamMax = Math.max(1, Number(exam.max_score || 100));
  const currentBySubject = new Map(currentRows.map((row) => [row.subject_id, row]));
  const componentBySubject = new Map(componentRows.map((row) => [row.subject_id, row]));
  const subjectIds = new Set([...currentBySubject.keys(), ...componentBySubject.keys()]);

  const results = [];
  for (const subjectId of subjectIds) {
    const current = currentBySubject.get(subjectId);
    const component = componentBySubject.get(subjectId);
    if (exam.type === 'test' && !current) {
      continue;
    }
    const currentScore = Number(current?.score ?? 0);
    const componentScore = Number(component?.score ?? 0);
    const currentSubjectMax = getSubjectMaxScore(subjectMaxScoreMap, subjectId, currentExamMax);
    const componentSubjectMax = getSubjectMaxScore(componentMaxScoreMap, subjectId, componentExamMax);
    const finalScore = Number(
      (
        ((componentScore / componentSubjectMax) * componentWeight)
        + ((currentScore / currentSubjectMax) * currentWeight)
      ).toFixed(2)
    );
    if (isMidterm) {
      results.push(buildMidtermResultRow({
        subject_id: subjectId,
        subject_name: current?.subject_name || component?.subject_name || '',
        subject_code: current?.subject_code || component?.subject_code || '',
        current_score: currentScore,
        component_score: componentScore,
        subject_max_score: currentSubjectMax,
      }, finalScore));
      continue;
    }
    const subjectGrading = resolveSubjectGrading(profileMap, subjectId, exam.grading_system);
    const gradeInfo = getGrade(finalScore, subjectGrading.gradingSystem, subjectGrading.customCriteria);
    const pointBased = isSubjectPointBased(subjectGrading);

    results.push({
      subject_id: subjectId,
      subject_name: current?.subject_name || component?.subject_name || '',
      subject_code: current?.subject_code || component?.subject_code || '',
      score: finalScore,
      current_score: currentScore,
      component_score: componentScore,
      subject_max_score: currentSubjectMax,
      grading_system: subjectGrading.gradingSystem,
      point_based: pointBased,
      grade: gradeInfo.grade,
      points: gradeInfo.points,
      remark: gradeInfo.remark,
    });
  }

  const totalScore = results.reduce((sum, r) => sum + Number(r.score || 0), 0);
  const averageScore = results.length > 0 ? totalScore / results.length : 0;

  return {
    results,
    totalScore,
    averageScore,
    subjectCount: results.length,
  };
}

export function rankStudentsByExam(examId) {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
  if (!exam) return [];

  const hasComponent = !!exam.component_exam_id;
  const students = db.prepare(`
    SELECT DISTINCT s.*
    FROM students s
    WHERE s.class_id = ?
      AND (
        EXISTS (SELECT 1 FROM exam_results er WHERE er.exam_id = ? AND er.student_id = s.id)
        OR (? = 1 AND EXISTS (SELECT 1 FROM exam_results er2 WHERE er2.exam_id = ? AND er2.student_id = s.id))
      )
  `).all(exam.class_id, examId, hasComponent ? 1 : 0, exam.component_exam_id || '');

  const studentScores = students.map((student) => {
    const { totalScore, averageScore, subjectCount, results } = calculateStudentResults(examId, student.id);
    const pointsMode = hasPointBasedResults(results);
    const totalPoints = pointsMode
      ? calculateBestSixPoints(results)
      : null;

    return {
      student,
      totalScore,
      averageScore,
      totalPoints,
      subjectCount,
      pointsMode,
      rank: 0,
    };
  });

  const isMidterm = String(exam.type || '').toLowerCase() === 'midterm';
  const usePointsForRanking = !isMidterm && studentScores.length > 0 && studentScores.every((row) => row.pointsMode);
  if (usePointsForRanking) {
    studentScores.sort((a, b) => (a.totalPoints || 0) - (b.totalPoints || 0));
  } else {
    studentScores.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return b.averageScore - a.averageScore;
    });
  }

  let currentRank = 1;
  for (let i = 0; i < studentScores.length; i++) {
    if (i > 0) {
      const prev = studentScores[i - 1];
      const curr = studentScores[i];
      if (usePointsForRanking) {
        if (curr.totalPoints !== prev.totalPoints) {
          currentRank = i + 1;
        }
      } else if (curr.totalScore !== prev.totalScore || curr.averageScore !== prev.averageScore) {
        currentRank = i + 1;
      }
    }
    studentScores[i].rank = currentRank;
  }

  return studentScores;
}

export function getOverallGrade(averageScore, system = 'normal') {
  return getGrade(averageScore, system);
}

export function getRankSuffix(rank) {
  if (rank % 100 >= 11 && rank % 100 <= 13) {
    return 'th';
  }
  switch (rank % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function formatRank(rank) {
  return `${rank}${getRankSuffix(rank)}`;
}
