const PASS_MARK = 50;
const STUDENT_TARGET_AVERAGE = 65;
const CLASS_TARGET_AVERAGE = 60;
const WEEKS_PER_ASSESSMENT = 4;

function roundNumber(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function average(values = []) {
  const items = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!items.length) return null;
  return items.reduce((sum, value) => sum + value, 0) / items.length;
}

function clampScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function toPerformanceBand(score) {
  if (!Number.isFinite(Number(score))) return 'No Data';
  if (score >= 75) return 'Excelling';
  if (score >= 60) return 'Steady';
  if (score >= 40) return 'Needs Support';
  return 'At Risk';
}

function toRiskLevel(score, weaknessCount = 0) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return 'No Data';
  if (numeric < 40 || weaknessCount >= 3) return 'High';
  if (numeric < 55 || weaknessCount >= 2) return 'Medium';
  return 'Low';
}

function buildSuggestion({ averageScore, strengths, weaknesses, estimatedRecoveryWeeks, subjectLabel = 'subject work' }) {
  if (!Number.isFinite(Number(averageScore))) {
    return 'No recorded marks yet. Enter results for this learner to unlock guidance.';
  }
  if (averageScore >= 75) {
    return `Keep stretching ${strengths[0]?.subject_name || 'this learner'} with higher-order practice while protecting consistency in ${weaknesses[0]?.subject_name || subjectLabel}.`;
  }
  if (averageScore >= 60) {
    return `Consolidate the gains and target ${weaknesses[0]?.subject_name || subjectLabel} with short weekly revision blocks.`;
  }
  if (estimatedRecoveryWeeks === null) {
    return `Intervene early in ${weaknesses[0]?.subject_name || subjectLabel} and pair the learner with structured follow-up work.`;
  }
  return `Focus on ${weaknesses[0]?.subject_name || subjectLabel} and review progress every ${WEEKS_PER_ASSESSMENT} weeks to shorten recovery time.`;
}

function estimateRecoveryWeeks(points, targetAverage) {
  const cleaned = points
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (!cleaned.length) return null;

  const current = cleaned[cleaned.length - 1];
  if (current >= targetAverage) return 0;

  if (cleaned.length === 1) {
    return Math.max(4, Math.ceil(((targetAverage - current) / 5) * WEEKS_PER_ASSESSMENT));
  }

  const deltas = [];
  for (let index = 1; index < cleaned.length; index += 1) {
    deltas.push(cleaned[index] - cleaned[index - 1]);
  }

  const averageDelta = average(deltas);
  if (!Number.isFinite(averageDelta) || averageDelta <= 0) {
    return null;
  }

  const assessmentsNeeded = (targetAverage - current) / averageDelta;
  return Math.max(1, Math.ceil(assessmentsNeeded * WEEKS_PER_ASSESSMENT));
}

function normalizeResults(results = []) {
  return (results || []).map((row) => ({
    subject_id: row.subject_id,
    subject_name: row.subject_name,
    subject_code: row.subject_code,
    score: roundNumber(row.score),
    grade: row.grade || null,
    points: Number.isFinite(Number(row.points)) ? Number(row.points) : null,
    remark: row.remark || null,
  }));
}

function summarizeTrendPoints(points = []) {
  return points
    .filter((point) => Number.isFinite(Number(point?.average)))
    .map((point) => ({
      exam_id: point.exam_id,
      label: point.label,
      average: roundNumber(point.average),
    }));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getAccessibleClassIds(user, isAdminUser, getAssignedClassIds) {
  if (isAdminUser(user)) return null;
  return Array.from(new Set(safeArray(getAssignedClassIds(user.id))));
}

function buildInClause(values = []) {
  if (!values.length) return { clause: '', params: [] };
  return {
    clause: `(${values.map(() => '?').join(',')})`,
    params: values,
  };
}

function buildSchoolPortfolio({ db, allowedClassIds, calculateStudentResults }) {
  let classes = db.prepare('SELECT id, name, year FROM classes ORDER BY year DESC, name ASC').all();
  if (allowedClassIds) {
    const allowed = new Set(allowedClassIds);
    classes = classes.filter((classRoom) => allowed.has(classRoom.id));
  }

  const classSnapshots = [];
  classes.forEach((classRoom) => {
    const latestExam = db.prepare(`
      SELECT id, class_id, name, term, year, grading_system, created_at
      FROM exams
      WHERE class_id = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1
    `).get(classRoom.id);

    if (!latestExam) return;

    const students = db.prepare(`
      SELECT id
      FROM students
      WHERE class_id = ?
    `).all(classRoom.id);

    const averages = students
      .map((student) => calculateStudentResults(latestExam.id, student.id))
      .filter((result) => Number(result?.subjectCount || 0) > 0)
      .map((result) => Number(result.averageScore));

    const classAverage = average(averages);
    if (!Number.isFinite(classAverage)) return;

    classSnapshots.push({
      class_id: classRoom.id,
      class_name: classRoom.name,
      year: classRoom.year,
      exam_id: latestExam.id,
      exam_name: latestExam.name,
      average: roundNumber(classAverage),
    });
  });

  const schoolAverage = average(classSnapshots.map((item) => item.average));
  const topClass = classSnapshots.slice().sort((left, right) => Number(right.average) - Number(left.average))[0] || null;
  const needsSupportClass = classSnapshots.slice().sort((left, right) => Number(left.average) - Number(right.average))[0] || null;

  return {
    classes_analyzed: classSnapshots.length,
    school_average: roundNumber(schoolAverage),
    top_class: topClass,
    needs_support_class: needsSupportClass,
    recommendation: !classSnapshots.length
      ? 'Create at least one exam with recorded results to unlock school-wide analytics.'
      : schoolAverage !== null && schoolAverage >= CLASS_TARGET_AVERAGE
        ? 'The overall school trend is stable. Concentrate support on the lowest-performing class.'
        : 'Prioritize intervention planning for the lowest-performing class, then compare the next exam cycle against this baseline.',
  };
}

function resolveExamWindow(db, exam) {
  const rows = db.prepare(`
    SELECT id, name, term, year, grading_system, created_at
    FROM exams
    WHERE class_id = ?
      AND datetime(created_at) <= datetime(?)
    ORDER BY datetime(created_at) DESC, rowid DESC
    LIMIT 4
  `).all(exam.class_id, exam.created_at);

  const deduped = new Map();
  rows.forEach((row) => {
    deduped.set(row.id, row);
  });
  if (!deduped.has(exam.id)) {
    deduped.set(exam.id, exam);
  }

  return Array.from(deduped.values()).sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
}

function createSubjectAccumulator(subjects = []) {
  const map = new Map();
  subjects.forEach((subject) => {
    map.set(subject.id, {
      subject_id: subject.id,
      subject_name: subject.name,
      subject_code: subject.code,
      scores: [],
      pass_count: 0,
    });
  });
  return map;
}

function finalizeSubjectInsights(subjectAccumulator) {
  return Array.from(subjectAccumulator.values())
    .map((item) => {
      const subjectAverage = average(item.scores);
      const passRate = item.scores.length
        ? (item.pass_count / item.scores.length) * 100
        : null;

      return {
        subject_id: item.subject_id,
        subject_name: item.subject_name,
        subject_code: item.subject_code,
        average: roundNumber(subjectAverage),
        pass_rate: roundNumber(passRate, 1),
        difficulty: subjectAverage === null
          ? 'No Data'
          : subjectAverage >= 70
            ? 'Strong'
            : subjectAverage >= 50
              ? 'Mixed'
              : 'Weak',
        recommendation: subjectAverage === null
          ? 'Record results to analyze this subject.'
          : subjectAverage >= 70
            ? 'Maintain stretch work and protect the current teaching rhythm.'
            : subjectAverage >= 50
              ? 'Reinforce core concepts and target error patterns from the last assessment.'
              : 'This subject needs urgent support, reteaching, and guided practice.',
      };
    })
    .sort((left, right) => {
      if (left.average === null) return 1;
      if (right.average === null) return -1;
      return Number(right.average) - Number(left.average);
    });
}

export function readOaeState(db) {
  const school = db.prepare(`
    SELECT school_id, oae_enabled, oae_activated_at, oae_activated_by
    FROM school_info
    WHERE id = 1
  `).get() || {};

  return {
    school_id: school.school_id || null,
    enabled: Number(school.oae_enabled || 0) === 1,
    activated_at: school.oae_activated_at || null,
    activated_by: school.oae_activated_by || null,
  };
}

export function updateOaeState(db, { enabled, activatedBy }) {
  db.prepare(`
    UPDATE school_info
    SET oae_enabled = ?,
        oae_activated_at = CASE WHEN ? = 1 THEN COALESCE(oae_activated_at, CURRENT_TIMESTAMP) ELSE NULL END,
        oae_activated_by = CASE WHEN ? = 1 THEN ? ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, enabled ? activatedBy || null : null);

  return readOaeState(db);
}

export function resolveAnalyticsExam({ db, user, examId, classId, isAdminUser, getAssignedClassIds }) {
  const allowedClassIds = getAccessibleClassIds(user, isAdminUser, getAssignedClassIds);

  if (examId) {
    const exam = db.prepare(`
      SELECT e.*, c.name as class_name, c.year as class_year
      FROM exams e
      JOIN classes c ON c.id = e.class_id
      WHERE e.id = ?
    `).get(examId);

    if (!exam) return { exam: null, allowedClassIds };
    if (allowedClassIds && !allowedClassIds.includes(exam.class_id)) {
      return { exam: null, allowedClassIds };
    }
    return { exam, allowedClassIds };
  }

  let query = `
    SELECT e.*, c.name as class_name, c.year as class_year
    FROM exams e
    JOIN classes c ON c.id = e.class_id
  `;
  const params = [];
  const filters = [];

  if (classId) {
    filters.push('e.class_id = ?');
    params.push(classId);
  }

  if (allowedClassIds && allowedClassIds.length) {
    const { clause, params: inParams } = buildInClause(allowedClassIds);
    filters.push(`e.class_id IN ${clause}`);
    params.push(...inParams);
  } else if (allowedClassIds && !allowedClassIds.length) {
    return { exam: null, allowedClassIds };
  }

  if (filters.length) {
    query += ` WHERE ${filters.join(' AND ')}`;
  }

  query += ' ORDER BY datetime(e.created_at) DESC, e.rowid DESC LIMIT 1';

  return {
    exam: db.prepare(query).get(...params) || null,
    allowedClassIds,
  };
}

export function buildAnalyticsOverview({
  db,
  user,
  examId,
  classId,
  detailLevel = 'full',
  calculateStudentResults,
  getOverallGrade,
  rankStudentsByExam,
  isAdminUser,
  getAssignedClassIds,
}) {
  const { exam, allowedClassIds } = resolveAnalyticsExam({
    db,
    user,
    examId,
    classId,
    isAdminUser,
    getAssignedClassIds,
  });

  if (!exam) {
    return {
      selection: null,
      overview: null,
      students: [],
      subjects: [],
      categories: {
        gender: [],
        performance_bands: [],
      },
      trends: {
        class_average: [],
      },
      portfolio: buildSchoolPortfolio({ db, allowedClassIds, calculateStudentResults }),
      detail_level: detailLevel,
    };
  }

  const students = db.prepare(`
    SELECT id, name, gender, admission_number
    FROM students
    WHERE class_id = ?
    ORDER BY name ASC
  `).all(exam.class_id);

  const subjects = db.prepare(`
    SELECT id, name, code
    FROM subjects
    WHERE class_id = ?
    ORDER BY name ASC
  `).all(exam.class_id);

  const subjectAccumulator = createSubjectAccumulator(subjects);
  const examWindow = resolveExamWindow(db, exam);
  const rankingByStudentId = new Map(
    safeArray(rankStudentsByExam(exam.id)).map((row) => [row.student.id, row])
  );
  const classTrendAccumulator = new Map(
    examWindow.map((windowExam) => [
      windowExam.id,
      { exam_id: windowExam.id, label: `${windowExam.name} (${windowExam.term} ${windowExam.year})`, values: [] },
    ])
  );

  const studentInsights = students.map((student) => {
    const calculated = calculateStudentResults(exam.id, student.id);
    const results = normalizeResults(calculated.results);
    const averageScore = Number(calculated.subjectCount || 0) > 0
      ? roundNumber(calculated.averageScore)
      : null;

    results.forEach((result) => {
      const subjectEntry = subjectAccumulator.get(result.subject_id);
      if (!subjectEntry || result.score === null) return;
      subjectEntry.scores.push(result.score);
      if (Number(result.score) >= PASS_MARK) {
        subjectEntry.pass_count += 1;
      }
    });

    const strengths = results
      .slice()
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
      .slice(0, 3);
    const weaknesses = results
      .slice()
      .sort((left, right) => Number(left.score || 0) - Number(right.score || 0))
      .filter((result) => Number(result.score || 0) < PASS_MARK || Number(result.score || 0) < Number(averageScore || 0))
      .slice(0, 3);

    const trend = summarizeTrendPoints(
      examWindow.map((windowExam) => {
        const snapshot = calculateStudentResults(windowExam.id, student.id);
        if (!Number(snapshot?.subjectCount || 0)) return null;
        const point = {
          exam_id: windowExam.id,
          label: `${windowExam.name} (${windowExam.term} ${windowExam.year})`,
          average: snapshot.averageScore,
        };
        classTrendAccumulator.get(windowExam.id)?.values.push(snapshot.averageScore);
        return point;
      }).filter(Boolean)
    );

    const passRate = Number(calculated.subjectCount || 0) > 0
      ? roundNumber(
          (results.filter((result) => Number(result.score || 0) >= PASS_MARK).length / Number(calculated.subjectCount || 1)) * 100,
          1
        )
      : null;
    const gradeInfo = averageScore === null ? null : getOverallGrade(averageScore, exam.grading_system);
    const estimatedRecoveryWeeks = estimateRecoveryWeeks(
      trend.map((point) => point.average),
      STUDENT_TARGET_AVERAGE
    );
    const weaknessCount = weaknesses.length;

    return {
      student_id: student.id,
      student_name: student.name,
      gender: student.gender,
      admission_number: student.admission_number || null,
      average: averageScore,
      grade: gradeInfo?.grade || null,
      remark: gradeInfo?.remark || null,
      pass_rate: passRate,
      subject_count: Number(calculated.subjectCount || 0),
      strengths,
      weaknesses,
      trend,
      rank: rankingByStudentId.get(student.id)?.rank || null,
      risk_level: toRiskLevel(averageScore, weaknessCount),
      performance_band: toPerformanceBand(averageScore),
      estimated_recovery_weeks: estimatedRecoveryWeeks,
      suggestion: buildSuggestion({
        averageScore,
        strengths,
        weaknesses,
        estimatedRecoveryWeeks,
      }),
    };
  });

  const scorableStudents = studentInsights.filter((student) => Number.isFinite(Number(student.average)));
  const subjectInsights = finalizeSubjectInsights(subjectAccumulator);
  const classAverage = average(scorableStudents.map((student) => student.average));
  const classPassRate = scorableStudents.length
    ? (scorableStudents.filter((student) => Number(student.average || 0) >= PASS_MARK).length / scorableStudents.length) * 100
    : null;
  const classTrend = Array.from(classTrendAccumulator.values())
    .map((entry) => ({
      exam_id: entry.exam_id,
      label: entry.label,
      average: roundNumber(average(entry.values)),
    }))
    .filter((entry) => entry.average !== null);
  const classRecoveryWeeks = estimateRecoveryWeeks(
    classTrend.map((point) => point.average),
    CLASS_TARGET_AVERAGE
  );
  const weakestSubjects = subjectInsights
    .filter((subject) => subject.average !== null)
    .slice()
    .sort((left, right) => Number(left.average) - Number(right.average))
    .slice(0, 3);
  const strongestSubjects = subjectInsights
    .filter((subject) => subject.average !== null)
    .slice()
    .sort((left, right) => Number(right.average) - Number(left.average))
    .slice(0, 3);

  const genderGroups = ['Male', 'Female']
    .map((gender) => {
      const items = scorableStudents.filter((student) => student.gender === gender);
      return {
        category: gender,
        count: items.length,
        average: roundNumber(average(items.map((student) => student.average))),
        pass_rate: items.length
          ? roundNumber((items.filter((student) => Number(student.average || 0) >= PASS_MARK).length / items.length) * 100, 1)
          : null,
      };
    })
    .filter((group) => group.count > 0);

  const performanceBands = ['Excelling', 'Steady', 'Needs Support', 'At Risk']
    .map((band) => {
      const count = scorableStudents.filter((student) => student.performance_band === band).length;
      return {
        band,
        count,
        percentage: scorableStudents.length ? roundNumber((count / scorableStudents.length) * 100, 1) : 0,
      };
    });

  return {
    selection: {
      exam_id: exam.id,
      exam_name: exam.name,
      class_id: exam.class_id,
      class_name: exam.class_name,
      class_year: exam.class_year,
      term: exam.term,
      year: exam.year,
      grading_system: exam.grading_system,
    },
    overview: {
      class_average: roundNumber(classAverage),
      class_pass_rate: roundNumber(classPassRate, 1),
      student_count: students.length,
      scored_student_count: scorableStudents.length,
      subject_count: subjects.length,
      estimated_recovery_weeks: classRecoveryWeeks,
      target_average: CLASS_TARGET_AVERAGE,
      strengths: strongestSubjects,
      weaknesses: weakestSubjects,
      suggestion: !scorableStudents.length
        ? 'Capture exam results to unlock class-level analytics.'
        : classAverage !== null && classAverage >= CLASS_TARGET_AVERAGE
          ? `The class is tracking well overall. Protect momentum in ${weakestSubjects[0]?.subject_name || 'the weaker subjects'}.`
          : `Prioritize support in ${weakestSubjects[0]?.subject_name || 'the weakest subject'} and compare progress against the next assessment cycle.`,
    },
    students: studentInsights.sort((left, right) => {
      const leftScore = Number.isFinite(Number(left.average)) ? Number(left.average) : -1;
      const rightScore = Number.isFinite(Number(right.average)) ? Number(right.average) : -1;
      return rightScore - leftScore;
    }),
    subjects: subjectInsights,
    categories: {
      gender: genderGroups,
      performance_bands: performanceBands,
    },
    trends: {
      class_average: classTrend,
    },
    portfolio: buildSchoolPortfolio({ db, allowedClassIds, calculateStudentResults }),
    detail_level: detailLevel,
  };
}

export function runAnalyticsSimulation({
  db,
  user,
  examId,
  classId,
  studentId,
  subjectId,
  uplift = 5,
  targetAverage = CLASS_TARGET_AVERAGE,
  calculateStudentResults,
  isAdminUser,
  getAssignedClassIds,
}) {
  const { exam } = resolveAnalyticsExam({
    db,
    user,
    examId,
    classId,
    isAdminUser,
    getAssignedClassIds,
  });

  if (!exam) {
    return null;
  }

  const selectedStudents = studentId
    ? db.prepare(`
        SELECT id, name
        FROM students
        WHERE id = ? AND class_id = ?
        LIMIT 1
      `).all(studentId, exam.class_id)
    : db.prepare(`
        SELECT id, name
        FROM students
        WHERE class_id = ?
      `).all(exam.class_id);

  const upliftValue = Math.max(0, Math.min(25, Number(uplift || 0)));
  const baseline = [];
  const projected = [];

  selectedStudents.forEach((student) => {
    const calculated = calculateStudentResults(exam.id, student.id);
    const normalized = normalizeResults(calculated.results);
    if (!normalized.length) return;

    const currentAverage = average(normalized.map((result) => result.score));
    baseline.push(currentAverage);

    const nextScores = normalized.map((result) => {
      if (subjectId && result.subject_id !== subjectId) {
        return Number(result.score || 0);
      }
      return clampScore(Number(result.score || 0) + upliftValue);
    });
    projected.push(average(nextScores));
  });

  const baselineAverage = average(baseline);
  const projectedAverage = average(projected);
  const baselinePassRate = baseline.length
    ? (baseline.filter((score) => Number(score) >= PASS_MARK).length / baseline.length) * 100
    : null;
  const projectedPassRate = projected.length
    ? (projected.filter((score) => Number(score) >= PASS_MARK).length / projected.length) * 100
    : null;
  const baselineRecovery = estimateRecoveryWeeks([baselineAverage], targetAverage);
  const projectedRecovery = estimateRecoveryWeeks([projectedAverage], targetAverage);

  return {
    exam: {
      exam_id: exam.id,
      exam_name: exam.name,
      class_id: exam.class_id,
      class_name: exam.class_name,
    },
    scope: studentId ? 'student' : 'class',
    uplift: upliftValue,
    subject_id: subjectId || null,
    target_average: targetAverage,
    baseline: {
      average: roundNumber(baselineAverage),
      pass_rate: roundNumber(baselinePassRate, 1),
      estimated_recovery_weeks: baselineRecovery,
      impacted_students: baseline.length,
    },
    projected: {
      average: roundNumber(projectedAverage),
      pass_rate: roundNumber(projectedPassRate, 1),
      estimated_recovery_weeks: projectedRecovery,
      impacted_students: projected.length,
    },
    impact: {
      average_delta: roundNumber((projectedAverage || 0) - (baselineAverage || 0)),
      pass_rate_delta: roundNumber((projectedPassRate || 0) - (baselinePassRate || 0), 1),
      recovery_weeks_saved:
        baselineRecovery !== null && projectedRecovery !== null
          ? Math.max(0, baselineRecovery - projectedRecovery)
          : null,
    },
    recommendation: projectedAverage !== null && projectedAverage >= targetAverage
      ? 'The simulation clears the target. The next step is to prioritize the same uplift strategy in real teaching time.'
      : 'Use the simulation as a planning guide, then target the weakest topics with structured follow-up work.',
  };
}
