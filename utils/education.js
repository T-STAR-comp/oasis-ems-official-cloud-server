export const SUPPORTED_COUNTRIES = ['Malawi', 'Nigeria'];
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
  Nigeria: [
    {
      key: 'ng_primary',
      label: 'Primary School (A-F)',
      pointBased: false,
    },
    {
      key: 'ng_jss',
      label: 'JSS Internal (A-F)',
      pointBased: false,
    },
    {
      key: 'ng_sss_internal',
      label: 'SSS Internal (A-F)',
      pointBased: false,
    },
    {
      key: 'ng_waec',
      label: 'WAEC/NECO (A1-F9)',
      pointBased: true,
      passPoints: 6,
      gradeDisplay: 'grade',
    },
    {
      key: 'ng_nabteb',
      label: 'NABTEB (A1-F9)',
      pointBased: true,
      passPoints: 6,
      gradeDisplay: 'grade',
    },
  ],
};

const POINT_BASED_SYSTEMS = new Set(
  Object.values(GRADING_SYSTEMS)
    .flat()
    .filter((system) => system.pointBased)
    .map((system) => system.key)
);

export const ALL_GRADING_SYSTEMS = Array.from(
  new Set(Object.values(GRADING_SYSTEMS).flat().map((system) => system.key))
);

export function normalizeCountry(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'nigeria') return 'Nigeria';
  return 'Malawi';
}

export function getGradingSystemsForCountry(country) {
  const normalized = normalizeCountry(country);
  return (GRADING_SYSTEMS[normalized] || GRADING_SYSTEMS[DEFAULT_COUNTRY]).map((system) => system.key);
}

export function getGradingSystemMeta(system) {
  const key = String(system || '').trim();
  for (const group of Object.values(GRADING_SYSTEMS)) {
    const found = group.find((entry) => entry.key === key);
    if (found) return found;
  }
  return null;
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

export function getFallbackGrade(system) {
  if (system === 'msce') {
    return { grade: '9', points: 9, remark: 'Fail' };
  }
  if (system === 'ng_waec' || system === 'ng_nabteb') {
    return { grade: 'F9', points: 9, remark: 'Fail' };
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
  ng_primary: [
    { grade: 'A', min_score: 75, max_score: 100, points: null, remark: 'Excellent' },
    { grade: 'B', min_score: 65, max_score: 74, points: null, remark: 'Very Good' },
    { grade: 'C', min_score: 50, max_score: 64, points: null, remark: 'Good' },
    { grade: 'D', min_score: 40, max_score: 49, points: null, remark: 'Pass' },
    { grade: 'F', min_score: 0, max_score: 39, points: null, remark: 'Fail' },
  ],
  ng_jss: [
    { grade: 'A', min_score: 70, max_score: 100, points: null, remark: 'Excellent' },
    { grade: 'B', min_score: 60, max_score: 69, points: null, remark: 'Very Good' },
    { grade: 'C', min_score: 50, max_score: 59, points: null, remark: 'Credit / Good' },
    { grade: 'D', min_score: 45, max_score: 49, points: null, remark: 'Pass' },
    { grade: 'E', min_score: 40, max_score: 44, points: null, remark: 'Pass' },
    { grade: 'F', min_score: 0, max_score: 39, points: null, remark: 'Fail' },
  ],
  ng_sss_internal: [
    { grade: 'A', min_score: 80, max_score: 100, points: null, remark: 'Excellent' },
    { grade: 'B', min_score: 70, max_score: 79, points: null, remark: 'Very Good' },
    { grade: 'C', min_score: 60, max_score: 69, points: null, remark: 'Good' },
    { grade: 'D', min_score: 50, max_score: 59, points: null, remark: 'Fair' },
    { grade: 'E', min_score: 40, max_score: 49, points: null, remark: 'Pass' },
    { grade: 'F', min_score: 0, max_score: 39, points: null, remark: 'Fail' },
  ],
  ng_waec: [
    { grade: 'A1', min_score: 75, max_score: 100, points: 1, remark: 'Distinction' },
    { grade: 'B2', min_score: 70, max_score: 74, points: 2, remark: 'Distinction' },
    { grade: 'B3', min_score: 65, max_score: 69, points: 3, remark: 'Distinction' },
    { grade: 'C4', min_score: 60, max_score: 64, points: 4, remark: 'Credit' },
    { grade: 'C5', min_score: 55, max_score: 59, points: 5, remark: 'Credit' },
    { grade: 'C6', min_score: 50, max_score: 54, points: 6, remark: 'Credit' },
    { grade: 'D7', min_score: 45, max_score: 49, points: 7, remark: 'Pass' },
    { grade: 'E8', min_score: 40, max_score: 44, points: 8, remark: 'Pass' },
    { grade: 'F9', min_score: 0, max_score: 39, points: 9, remark: 'Fail' },
  ],
  ng_nabteb: [
    { grade: 'A1', min_score: 75, max_score: 100, points: 1, remark: 'Distinction' },
    { grade: 'B2', min_score: 70, max_score: 74, points: 2, remark: 'Distinction' },
    { grade: 'B3', min_score: 65, max_score: 69, points: 3, remark: 'Distinction' },
    { grade: 'C4', min_score: 60, max_score: 64, points: 4, remark: 'Credit' },
    { grade: 'C5', min_score: 55, max_score: 59, points: 5, remark: 'Credit' },
    { grade: 'C6', min_score: 50, max_score: 54, points: 6, remark: 'Credit' },
    { grade: 'D7', min_score: 45, max_score: 49, points: 7, remark: 'Pass' },
    { grade: 'E8', min_score: 40, max_score: 44, points: 8, remark: 'Pass' },
    { grade: 'F9', min_score: 0, max_score: 39, points: 9, remark: 'Fail' },
  ],
};

export function getDefaultCriteriaForSystem(system) {
  return DEFAULT_GRADE_CRITERIA[system] || [];
}

const MALAWI_SUBJECTS = [
  { name: 'English Language', code: 'ENG', is_compulsory: 1 },
  { name: 'Chichewa', code: 'CHI', is_compulsory: 1 },
  { name: 'Mathematics', code: 'MATH', is_compulsory: 1 },
  { name: 'Biology', code: 'BIO', is_compulsory: 1 },
  { name: 'Chemistry', code: 'CHEM', is_compulsory: 1 },
  { name: 'Physics', code: 'PHY', is_compulsory: 1 },
  { name: 'Social Studies', code: 'SS', is_compulsory: 1 },
  { name: 'History', code: 'HIS', is_compulsory: 0 },
  { name: 'Geography', code: 'GEO', is_compulsory: 0 },
  { name: 'Agriculture', code: 'AGR', is_compulsory: 0 },
];

const NIGERIA_PRIMARY_SUBJECTS = [
  { name: 'English Language', code: 'ENG', is_compulsory: 1 },
  { name: 'Mathematics', code: 'MATH', is_compulsory: 1 },
  { name: 'Social Studies', code: 'SOS', is_compulsory: 1 },
  { name: 'Basic Science', code: 'BS', is_compulsory: 1 },
  { name: 'Civic Education', code: 'CIV', is_compulsory: 1 },
  { name: 'Cultural & Creative Arts', code: 'CCA', is_compulsory: 1 },
  { name: 'Agricultural Science', code: 'AGR', is_compulsory: 1 },
  { name: 'Computer Studies', code: 'COMP', is_compulsory: 1 },
  { name: 'Religious Studies (CRS/IRS)', code: 'REL', is_compulsory: 0 },
  { name: 'French', code: 'FR', is_compulsory: 0 },
];

const NIGERIA_JSS_SUBJECTS = [
  { name: 'English Language', code: 'ENG', is_compulsory: 1 },
  { name: 'Mathematics', code: 'MATH', is_compulsory: 1 },
  { name: 'Basic Science & Technology', code: 'BST', is_compulsory: 1 },
  { name: 'Social Studies', code: 'SOS', is_compulsory: 1 },
  { name: 'Civic Education', code: 'CIV', is_compulsory: 1 },
  { name: 'Business Studies', code: 'BUS', is_compulsory: 0 },
  { name: 'French', code: 'FR', is_compulsory: 0 },
  { name: 'Computer Studies', code: 'COMP', is_compulsory: 0 },
  { name: 'Home Economics', code: 'HE', is_compulsory: 0 },
  { name: 'Fine Arts', code: 'FA', is_compulsory: 0 },
  { name: 'Religious Studies (CRS/IRS)', code: 'REL', is_compulsory: 0 },
];

const NIGERIA_SSS_SUBJECTS = [
  { name: 'English Language', code: 'ENG', is_compulsory: 1 },
  { name: 'Mathematics', code: 'MATH', is_compulsory: 1 },
  { name: 'Civic Education', code: 'CIV', is_compulsory: 1 },
  { name: 'Economics', code: 'ECO', is_compulsory: 1 },
  { name: 'Biology', code: 'BIO', is_compulsory: 0 },
  { name: 'Chemistry', code: 'CHEM', is_compulsory: 0 },
  { name: 'Physics', code: 'PHY', is_compulsory: 0 },
  { name: 'Government', code: 'GOV', is_compulsory: 0 },
  { name: 'Literature-in-English', code: 'LIT', is_compulsory: 0 },
  { name: 'Financial Accounting', code: 'ACC', is_compulsory: 0 },
  { name: 'Commerce', code: 'COM', is_compulsory: 0 },
  { name: 'Agricultural Science', code: 'AGR', is_compulsory: 0 },
  { name: 'Further Mathematics', code: 'FM', is_compulsory: 0 },
];

export function getDefaultClassesForCountry(country, year) {
  const normalized = normalizeCountry(country);
  const academicYear = String(year || new Date().getFullYear());

  if (normalized === 'Nigeria') {
    // Nigerian schools create classes manually per school policy.
    return [];
  }

  return ['Form 1', 'Form 2', 'Form 3', 'Form 4'].map((name) => ({
    name,
    year: academicYear,
    min_subjects: 6,
    max_subjects: 12,
    subjects: MALAWI_SUBJECTS,
  }));
}
