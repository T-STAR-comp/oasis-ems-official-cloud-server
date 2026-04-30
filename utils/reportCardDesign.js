export const DEFAULT_REPORT_CARD_DESIGN = {
  version: 1,
  enabled: false,
  page: {
    accentColor: '#1f4f82',
    backgroundColor: '#f8fafc',
    showCardBorders: true,
  },
  text: {
    reportTitle: 'SCHOOL REPORT',
    gradingKeyTitle: 'Grading Key',
    summaryTitle: 'Summary & Remarks',
  },
  blocks: {
    header: { x: 4, y: 3, width: 92, height: 13, visible: true },
    studentInfo: { x: 4, y: 18, width: 92, height: 12, visible: true },
    table: { x: 4, y: 32, width: 92, height: 34, visible: true },
    gradingKey: { x: 4, y: 68.5, width: 44, height: 11.5, visible: true },
    summary: { x: 52, y: 68.5, width: 44, height: 11.5, visible: true },
    footer: { x: 4, y: 82, width: 92, height: 10.5, visible: true },
  },
  features: {
    showLogo: true,
    showMotto: true,
    showContacts: true,
    showTeacherName: true,
    showStudentPosition: true,
    showStudentCount: true,
    showSubjectPosition: true,
    showSubjectSignature: true,
    showGradingKey: true,
    showSummary: true,
    showFooter: true,
    showOpeningDate: true,
    showSchoolFees: true,
    showHeadteacherName: true,
    showHeadteacherSignature: true,
    showPassFailRemark: true,
    showOverallGrade: true,
    showOverallPoints: true,
  },
};

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeColor(value, fallback) {
  const raw = String(value || '').trim();
  return /^#([a-f0-9]{3}|[a-f0-9]{6})$/i.test(raw) ? raw : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeText(value, fallback, maxLength = 80) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.slice(0, maxLength);
}

function normalizeBlock(value, fallback) {
  const input = value && typeof value === 'object' ? value : {};
  const width = clampNumber(input.width, 8, 96, fallback.width);
  const height = clampNumber(input.height, 6, 50, fallback.height);
  return {
    x: clampNumber(input.x, 0, 100 - width, fallback.x),
    y: clampNumber(input.y, 0, 100 - height, fallback.y),
    width,
    height,
    visible: normalizeBoolean(input.visible, fallback.visible),
  };
}

export function normalizeReportCardDesign(input) {
  const raw = typeof input === 'string'
    ? (() => {
        try {
          return JSON.parse(input);
        } catch {
          return {};
        }
      })()
    : (input && typeof input === 'object' ? input : {});

  return {
    version: 1,
    enabled: normalizeBoolean(raw.enabled, DEFAULT_REPORT_CARD_DESIGN.enabled),
    page: {
      accentColor: normalizeColor(raw.page?.accentColor, DEFAULT_REPORT_CARD_DESIGN.page.accentColor),
      backgroundColor: normalizeColor(raw.page?.backgroundColor, DEFAULT_REPORT_CARD_DESIGN.page.backgroundColor),
      showCardBorders: normalizeBoolean(raw.page?.showCardBorders, DEFAULT_REPORT_CARD_DESIGN.page.showCardBorders),
    },
    text: {
      reportTitle: normalizeText(raw.text?.reportTitle, DEFAULT_REPORT_CARD_DESIGN.text.reportTitle, 60),
      gradingKeyTitle: normalizeText(raw.text?.gradingKeyTitle, DEFAULT_REPORT_CARD_DESIGN.text.gradingKeyTitle, 50),
      summaryTitle: normalizeText(raw.text?.summaryTitle, DEFAULT_REPORT_CARD_DESIGN.text.summaryTitle, 50),
    },
    blocks: {
      header: normalizeBlock(raw.blocks?.header, DEFAULT_REPORT_CARD_DESIGN.blocks.header),
      studentInfo: normalizeBlock(raw.blocks?.studentInfo, DEFAULT_REPORT_CARD_DESIGN.blocks.studentInfo),
      table: normalizeBlock(raw.blocks?.table, DEFAULT_REPORT_CARD_DESIGN.blocks.table),
      gradingKey: normalizeBlock(raw.blocks?.gradingKey, DEFAULT_REPORT_CARD_DESIGN.blocks.gradingKey),
      summary: normalizeBlock(raw.blocks?.summary, DEFAULT_REPORT_CARD_DESIGN.blocks.summary),
      footer: normalizeBlock(raw.blocks?.footer, DEFAULT_REPORT_CARD_DESIGN.blocks.footer),
    },
    features: {
      showLogo: normalizeBoolean(raw.features?.showLogo, DEFAULT_REPORT_CARD_DESIGN.features.showLogo),
      showMotto: normalizeBoolean(raw.features?.showMotto, DEFAULT_REPORT_CARD_DESIGN.features.showMotto),
      showContacts: normalizeBoolean(raw.features?.showContacts, DEFAULT_REPORT_CARD_DESIGN.features.showContacts),
      showTeacherName: normalizeBoolean(raw.features?.showTeacherName, DEFAULT_REPORT_CARD_DESIGN.features.showTeacherName),
      showStudentPosition: normalizeBoolean(raw.features?.showStudentPosition, DEFAULT_REPORT_CARD_DESIGN.features.showStudentPosition),
      showStudentCount: normalizeBoolean(raw.features?.showStudentCount, DEFAULT_REPORT_CARD_DESIGN.features.showStudentCount),
      showSubjectPosition: normalizeBoolean(raw.features?.showSubjectPosition, DEFAULT_REPORT_CARD_DESIGN.features.showSubjectPosition),
      showSubjectSignature: normalizeBoolean(raw.features?.showSubjectSignature, DEFAULT_REPORT_CARD_DESIGN.features.showSubjectSignature),
      showGradingKey: normalizeBoolean(raw.features?.showGradingKey, DEFAULT_REPORT_CARD_DESIGN.features.showGradingKey),
      showSummary: normalizeBoolean(raw.features?.showSummary, DEFAULT_REPORT_CARD_DESIGN.features.showSummary),
      showFooter: normalizeBoolean(raw.features?.showFooter, DEFAULT_REPORT_CARD_DESIGN.features.showFooter),
      showOpeningDate: normalizeBoolean(raw.features?.showOpeningDate, DEFAULT_REPORT_CARD_DESIGN.features.showOpeningDate),
      showSchoolFees: normalizeBoolean(raw.features?.showSchoolFees, DEFAULT_REPORT_CARD_DESIGN.features.showSchoolFees),
      showHeadteacherName: normalizeBoolean(raw.features?.showHeadteacherName, DEFAULT_REPORT_CARD_DESIGN.features.showHeadteacherName),
      showHeadteacherSignature: normalizeBoolean(raw.features?.showHeadteacherSignature, DEFAULT_REPORT_CARD_DESIGN.features.showHeadteacherSignature),
      showPassFailRemark: normalizeBoolean(raw.features?.showPassFailRemark, DEFAULT_REPORT_CARD_DESIGN.features.showPassFailRemark),
      showOverallGrade: normalizeBoolean(raw.features?.showOverallGrade, DEFAULT_REPORT_CARD_DESIGN.features.showOverallGrade),
      showOverallPoints: normalizeBoolean(raw.features?.showOverallPoints, DEFAULT_REPORT_CARD_DESIGN.features.showOverallPoints),
    },
  };
}

export function resolveStoredReportCardDesign(value) {
  return normalizeReportCardDesign(value);
}
