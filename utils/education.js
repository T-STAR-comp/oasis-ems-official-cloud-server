export const SUPPORTED_COUNTRIES = ['Malawi'];
export const DEFAULT_COUNTRY = 'Malawi';

export const GRADING_SYSTEMS = {
  Malawi: [
    {
      key: 'normal',
      label: 'Standard Malawian Grading (A-F)',
      pointBased: false,
    },
    {
      key: 'msce',
      label: 'MSCE Points System (1-9)',
      pointBased: true,
      passPoints: 7,
      gradeDisplay: 'points',
    },
  ],
};

const POINT_BASED_SYSTEMS = new Set(
  GRADING_SYSTEMS.Malawi.filter((system) => system.pointBased).map((system) => system.key)
);

export const ALL_GRADING_SYSTEMS = GRADING_SYSTEMS.Malawi.map((system) => system.key);

export function normalizeCountry(_value) {
  return DEFAULT_COUNTRY;
}

export function getGradingSystemsForCountry(_country) {
  return ALL_GRADING_SYSTEMS.slice();
}

export function getGradingSystemMeta(system) {
  const key = String(system || '').trim();
  return GRADING_SYSTEMS.Malawi.find((entry) => entry.key === key) || null;
}

export function isSupportedGradingSystem(system) {
  return ALL_GRADING_SYSTEMS.includes(String(system || '').trim());
}

export function isPointBasedSystem(system) {
  return POINT_BASED_SYSTEMS.has(String(system || '').trim());
}

export function getPointPassThreshold(system) {
  const meta = getGradingSystemMeta(system);
  if (meta && Number.isFinite(Number(meta.passPoints))) {
    return Number(meta.passPoints);
  }
  return 7;
}

export function getGradeDisplayMode(system) {
  const meta = getGradingSystemMeta(system);
  if (meta?.gradeDisplay === 'points') return 'points';
  if (meta?.gradeDisplay === 'grade') return 'grade';
  return isPointBasedSystem(system) ? 'points' : 'grade';
}

export function getReportLabels(_country) {
  return {
    classLabel: 'Form / Class',
    teacherLabel: 'Form Teacher',
    termLabel: 'Term / Academic Year',
  };
}

export function getFallbackGrade(system) {
  if (system === 'msce') {
    return { grade: '9', points: 9, remark: 'Fail' };
  }
  return { grade: 'F', points: null, remark: 'Fail' };
}

export const DEFAULT_GRADE_CRITERIA = {
  normal: [
    { grade: 'A', min_score: 80, max_score: 100, points: null, remark: 'Excellent' },
    { grade: 'B', min_score: 65, max_score: 79, points: null, remark: 'Very Good' },
    { grade: 'C', min_score: 50, max_score: 64, points: null, remark: 'Good' },
    { grade: 'D', min_score: 40, max_score: 49, points: null, remark: 'Satisfactory' },
    { grade: 'E', min_score: 30, max_score: 39, points: null, remark: 'Fair' },
    { grade: 'F', min_score: 0, max_score: 29, points: null, remark: 'Fail' },
  ],
  msce: [
    { grade: '1', min_score: 75, max_score: 100, points: 1, remark: 'Distinction' },
    { grade: '2', min_score: 70, max_score: 74, points: 2, remark: 'Distinction' },
    { grade: '3', min_score: 65, max_score: 69, points: 3, remark: 'Credit' },
    { grade: '4', min_score: 60, max_score: 64, points: 4, remark: 'Credit' },
    { grade: '5', min_score: 55, max_score: 59, points: 5, remark: 'Credit' },
    { grade: '6', min_score: 50, max_score: 54, points: 6, remark: 'Pass' },
    { grade: '7', min_score: 40, max_score: 49, points: 7, remark: 'Pass' },
    { grade: '8', min_score: 30, max_score: 39, points: 8, remark: 'Fail' },
    { grade: '9', min_score: 0, max_score: 29, points: 9, remark: 'Fail' },
  ],
};

export function getDefaultCriteriaForSystem(system) {
  return DEFAULT_GRADE_CRITERIA[system] || [];
}

export function getDefaultClassesForCountry(_country, _year) {
  return [];
}
