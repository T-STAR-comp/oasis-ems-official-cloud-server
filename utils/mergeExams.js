/**
 * Build merged exam scores by averaging each included source exam's contribution
 * per student/subject (after scaling to the target max score).
 */
export function buildMergedResults(sourceRows, targetMaxScore, sourceExamIds = []) {
  const examIds = Array.from(new Set(
    (Array.isArray(sourceExamIds) ? sourceExamIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  ));

  const perExamTotals = new Map();
  sourceRows.forEach((row) => {
    const examId = String(row.source_exam_id || '').trim();
    if (!examId) return;

    const maxScore = Math.max(1, Number(row.source_max_score || 100));
    const normalizedScore = (Number(row.score) / maxScore) * targetMaxScore;
    const key = `${row.student_id}::${row.subject_id}::${examId}`;
    const current = perExamTotals.get(key) || { sum: 0, count: 0 };
    current.sum += normalizedScore;
    current.count += 1;
    perExamTotals.set(key, current);
  });

  const perExamAverages = new Map();
  perExamTotals.forEach((entry, key) => {
    perExamAverages.set(key, entry.sum / entry.count);
  });

  const studentSubjectKeys = new Set();
  perExamAverages.forEach((_value, key) => {
    const [studentId, subjectId] = key.split('::');
    studentSubjectKeys.add(`${studentId}::${subjectId}`);
  });

  const results = [];
  studentSubjectKeys.forEach((pairKey) => {
    const [student_id, subject_id] = pairKey.split('::');
    let sum = 0;
    let examsIncluded = 0;

    const examsToAverage = examIds.length > 0
      ? examIds
      : Array.from(new Set(
        Array.from(perExamAverages.keys()).map((key) => key.split('::')[2]),
      ));

    examsToAverage.forEach((examId) => {
      const examScore = perExamAverages.get(`${student_id}::${subject_id}::${examId}`);
      if (examScore === undefined) return;
      sum += examScore;
      examsIncluded += 1;
    });

    if (examsIncluded === 0) return;

    results.push({
      student_id,
      subject_id,
      score: Number((sum / examsIncluded).toFixed(2)),
    });
  });

  return results;
}
