import express from 'express';
import PDFDocument from 'pdfkit';
import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess } from '../middleware/auth.js';
import { rankStudentsByExam, getGrade, formatRank, calculateStudentResults, getGradeCriteria } from '../utils/grading.js';
import { renderStudentReportCardPage } from '../utils/reportCardPdf.js';
import { renderPaginatedClassResultsPdf } from '../utils/classResultsPdf.js';
import { buildStudentReportsZip } from '../utils/studentReportsZip.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.use(authenticateToken);

function resolveLogoPath(logo) {
  if (!logo) return null;
  const cleanPath = String(logo).replace(/^\/+/, '');
  const uploadsRoot = process.env.OASIS_UPLOADS_DIR
    ? path.resolve(process.env.OASIS_UPLOADS_DIR)
    : path.join(__dirname, '..', 'uploads');

  // New desktop-safe storage location: userData/uploads
  if (cleanPath.startsWith('uploads/')) {
    const uploadsRelative = cleanPath.slice('uploads/'.length);
    const uploadsAbsolute = path.join(uploadsRoot, uploadsRelative);
    if (fs.existsSync(uploadsAbsolute)) return uploadsAbsolute;
  }

  // Backward compatibility for legacy paths under server directory.
  const legacyAbsolute = path.join(__dirname, '..', cleanPath);
  return fs.existsSync(legacyAbsolute) ? legacyAbsolute : null;
}

function parseImageDataUrl(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  try {
    return {
      mimeType: match[1].toLowerCase(),
      buffer: Buffer.from(match[2], 'base64'),
    };
  } catch {
    return null;
  }
}

function drawHeadteacherSignature(doc, signatureValue, x, y, width) {
  const value = String(signatureValue || '').trim();
  doc.fillColor('#4a5a70').font('Helvetica').fontSize(10).text('Head Teacher Signature:', x, y);

  const parsedImage = parseImageDataUrl(value);
  if (parsedImage && ['image/png', 'image/jpeg', 'image/jpg'].includes(parsedImage.mimeType)) {
    try {
      doc.image(parsedImage.buffer, x, y + 14, { fit: [Math.max(80, width - 8), 28], align: 'left' });
      return;
    } catch {
      // Fall through to text rendering.
    }
  }

  const fallbackText = /^data:image\//i.test(value)
    ? '____________________'
    : (value || '____________________');
  doc.fillColor('#0f172a').font('Helvetica').fontSize(10).text(fallbackText, x, y + 18, {
    width: Math.max(80, width - 8),
    ellipsis: true,
  });
}

function drawCard(doc, x, y, width, height) {
  doc.save();
  doc.roundedRect(x, y, width, height, 10);
  doc.fillAndStroke('#ffffff', '#d9dee7');
  doc.restore();
}

function getReportLabels(country) {
  const normalized = String(country || '').trim().toLowerCase();
  if (normalized === 'nigeria') {
    return {
      classLabel: 'Class',
      teacherLabel: 'Class Teacher',
      termLabel: 'Term / Session',
    };
  }
  return {
    classLabel: 'Form / Class',
    teacherLabel: 'Form Teacher',
    termLabel: 'Term / Academic Year',
  };
}

function drawRowBackground(doc, x, y, width, height, color = '#ffffff') {
  doc.save();
  doc.rect(x, y, width, height).fill(color);
  doc.restore();
}

function getAdaptiveRowHeight(doc, yStart, rowCount, fixedAfterTable, min = 11, max = 20) {
  const pageBottom = doc.page.height - 24;
  const usable = Math.max(120, pageBottom - yStart - fixedAfterTable);
  const raw = Math.floor(usable / Math.max(2, rowCount + 1));
  return Math.max(min, Math.min(max, raw));
}

function formatOneDecimal(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num)) : '-';
}

function formatWholeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num)) : '-';
}

function formatPoints(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num)) : '-';
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  if (day % 10 === 1) return 'st';
  if (day % 10 === 2) return 'nd';
  if (day % 10 === 3) return 'rd';
  return 'th';
}

function formatDisplayDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return raw;
  const day = dt.getDate();
  const month = dt.toLocaleString('en-US', { month: 'long' });
  const year = dt.getFullYear();
  return `${day}${ordinalSuffix(day)} ${month} ${year}`;
}

function getFormTeacherName(classId) {
  const row = db.prepare(`
    SELECT COALESCE(u.full_name, u.username) as teacher_name
    FROM users u
    JOIN user_class_assignments uca ON uca.user_id = u.id
    WHERE uca.class_id = ? AND u.role = 'teacher'
    ORDER BY (
      SELECT COUNT(*) FROM user_class_assignments x WHERE x.user_id = u.id
    ) ASC, u.created_at ASC
    LIMIT 1
  `).get(classId);
  return row?.teacher_name || '';
}

function isEnglishSubject(row) {
  const code = String(row?.subject_code || '').trim().toUpperCase();
  const name = String(row?.subject_name || '').trim().toLowerCase();
  return code === 'ENG' || code === 'ENGLISH' || name === 'english' || name === 'english language';
}

function isPassingRow(row, gradingSystem) {
  if (!row) return false;
  const rowSystem = row.grading_system || gradingSystem;
  if (rowSystem === 'msce') {
    const points = Number(row.points);
    return Number.isFinite(points) ? points <= 7 : false;
  }
  const grade = String(row.grade || '').trim().toUpperCase();
  if (grade === 'F') return false;
  const remark = String(row.remark || '').trim().toLowerCase();
  if (remark.includes('fail')) return false;
  return true;
}

function getMerePassGrade(system) {
  const criteria = getGradeCriteria(system);
  const passingRows = criteria.filter((row) => {
    const grade = String(row?.grade || '').trim().toUpperCase();
    const remark = String(row?.remark || '').trim().toLowerCase();
    if (system === 'msce') {
      const points = Number(row?.points);
      if (Number.isFinite(points) && points <= 7) return true;
    }
    return grade !== 'F' && !remark.includes('fail');
  });

  if (!passingRows.length) {
    return system === 'msce'
      ? { grade: '7', points: 7, remark: 'Pass (English requirement)' }
      : { grade: 'D', points: null, remark: 'Pass (English requirement)' };
  }

  const merePass = system === 'msce'
    ? passingRows.reduce((worst, row) => (Number(row.points) > Number(worst.points) ? row : worst))
    : passingRows.reduce((worst, row) => (Number(row.min_score) < Number(worst.min_score) ? row : worst));

  return {
    grade: merePass.grade,
    points: merePass.points ?? null,
    remark: merePass.remark || 'Pass (English requirement)',
  };
}

function getOverallGradeWithEnglishRule(exam, averageScore, results) {
  const base = getGrade(averageScore, exam.grading_system);
  const englishRow = Array.isArray(results) ? results.find(isEnglishSubject) : null;
  if (!englishRow) return base;
  const englishPassed = isPassingRow(englishRow, exam.grading_system);
  if (!englishPassed) {
    return exam.grading_system === 'msce'
    ? { grade: '9', points: 9, remark: 'Fail (English requirement)' }
    : { grade: 'F', points: null, remark: 'Fail (English requirement)' };
  }
  if (isPassingRow(base, exam.grading_system)) return base;
  return getMerePassGrade(exam.grading_system);
}

function getPassFailRemark(exam, results = []) {
  const rows = Array.isArray(results) ? results : [];
  const passedSubjects = rows.filter((row) => isPassingRow(row, exam.grading_system)).length;
  const englishRow = rows.find(isEnglishSubject);
  const englishPassed = isPassingRow(englishRow, exam.grading_system);
  const passed = englishPassed && passedSubjects >= 6;
  if (passed) {
    return { status: 'Pass', detail: 'Pass (minimum 6 subjects including English met)' };
  }
  return { status: 'Fail', detail: 'Fail (must pass English and at least 6 subjects)' };
}

function buildSubjectRankMaps(scoreRows) {
  const bySubject = new Map();

  for (const row of scoreRows) {
    if (!bySubject.has(row.subject_id)) {
      bySubject.set(row.subject_id, []);
    }
    bySubject.get(row.subject_id).push(row);
  }

  const rankMaps = new Map();
  for (const [subjectId, rows] of bySubject.entries()) {
    rows.sort((a, b) => b.score - a.score);
    const rankMap = new Map();
    let currentRank = 1;
    let previousScore = null;

    rows.forEach((row, index) => {
      if (previousScore === null || row.score !== previousScore) {
        currentRank = index + 1;
      }
      rankMap.set(row.student_id, currentRank);
      previousScore = row.score;
    });

    rankMaps.set(subjectId, rankMap);
  }

  return rankMaps;
}

// Get student report card data
router.get('/student/:studentId/exam/:examId', (req, res) => {
  const { studentId, examId } = req.params;

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ?
  `).get(examId);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  const calculated = calculateStudentResults(examId, studentId);
  const results = calculated.results
    .slice()
    .sort((a, b) => (a.subject_name || '').localeCompare(b.subject_name || ''));

  const rankings = rankStudentsByExam(examId);
  const studentRanking = rankings.find(r => r.student.id === studentId);

  const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();

  const totalScore = calculated.totalScore;
  const averageScore = calculated.averageScore;
  const overallGrade = getOverallGradeWithEnglishRule(exam, averageScore, results);
  const passFail = getPassFailRemark(exam, results);

  res.json({
    reportCard: {
      school: schoolInfo,
      student,
      exam,
      weighting: {
        componentExamName: exam.component_exam_name || null,
        componentWeight: Number(exam.component_weight || 0),
        currentWeight: Number(exam.current_weight || 100)
      },
      results,
      summary: {
        totalScore,
        averageScore: Math.round(averageScore),
        rank: studentRanking?.rank || 0,
        totalStudents: rankings.length,
        overallGrade: overallGrade.grade,
        overallRemark: passFail.status,
        overallRemarkDetail: passFail.detail
      }
    }
  });
});

// Download student report card as PDF
router.get('/student/:studentId/exam/:examId/pdf', async (req, res) => {
  const { studentId, examId } = req.params;

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ?
  `).get(examId);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, exam.class_id)) return;

  const calculated = calculateStudentResults(examId, studentId);
  const results = calculated.results
    .slice()
    .sort((a, b) => (a.subject_name || '').localeCompare(b.subject_name || ''));

  const rankings = rankStudentsByExam(examId);
  const studentRanking = rankings.find(r => r.student.id === studentId);
  const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
  const formTeacherName = getFormTeacherName(exam.class_id);
  const logoPath = resolveLogoPath(schoolInfo?.logo);

  const allScores = [];
  rankings.forEach((entry) => {
    const r = calculateStudentResults(examId, entry.student.id);
    r.results.forEach((subjectRow) => {
      allScores.push({
        student_id: entry.student.id,
        subject_id: subjectRow.subject_id,
        score: subjectRow.score
      });
    });
  });
  const subjectRankMaps = buildSubjectRankMaps(allScores);

  const criteria = db.prepare(`
    SELECT grade, min_score, max_score, points, remark
    FROM grade_criteria
    WHERE system = ?
    ORDER BY min_score DESC
  `).all(exam.grading_system);
  const classSubjects = db.prepare(`
    SELECT id, teacher_name
    FROM subjects
    WHERE class_id = ?
  `).all(exam.class_id);
  const subjectTeacherMap = new Map(classSubjects.map((row) => [row.id, row.teacher_name || '']));

  const totalScore = calculated.totalScore;
  const averageScore = calculated.averageScore;
  const overallGrade = getOverallGradeWithEnglishRule(exam, averageScore, results);
  const passFail = getPassFailRemark(exam, results);

  const customDoc = new PDFDocument({ margin: 24, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${student.name.replace(/\s+/g, '_')}_report_card.pdf"`);
  customDoc.pipe(res);
  renderStudentReportCardPage({
    doc: customDoc,
    schoolInfo,
    student,
    exam,
    rankingsCount: rankings.length,
    studentRank: studentRanking?.rank || 0,
    totalPoints: studentRanking?.totalPoints,
    formTeacherName,
    logoPath,
    criteria,
    results,
    totalScore,
    overallGrade,
    passFail,
    subjectTeacherMap,
    subjectRankMaps,
    studentId,
  });
  customDoc.end();
  return;

  const doc = new PDFDocument({ margin: 24, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${student.name.replace(/\s+/g, '_')}_report_card.pdf"`);

  doc.pipe(res);

  const pageWidth = doc.page.width;
  const contentX = 24;
  const contentWidth = pageWidth - 48;

  let y = 24;

  // Header card (single logo)
  drawCard(doc, contentX, y, contentWidth, 112);
  if (logoPath) {
    doc.image(logoPath, contentX + 14, y + 16, { fit: [72, 72] });
  }

  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
    .text(schoolInfo.name || 'SCHOOL', contentX + 94, y + 18, { width: contentWidth - 108, align: 'center' });

  doc.fillColor('#5b6b80').font('Helvetica').fontSize(11)
    .text(schoolInfo.address || '', contentX + 94, y + 46, { width: contentWidth - 108, align: 'center' });
  doc.text(`Tel: ${schoolInfo.phone || '-'} | Email: ${schoolInfo.email || '-'}`, contentX + 94, y + 64, {
    width: contentWidth - 108,
    align: 'center'
  });
  const headerMotto = String(schoolInfo.motto || '').trim();
  if (headerMotto) {
    doc.font('Helvetica-Oblique').text(headerMotto, contentX + 94, y + 78, {
      width: contentWidth - 108,
      align: 'center',
      lineBreak: false,
      ellipsis: true
    });
  }

  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13)
    .text('SCHOOL REPORT', contentX + 94, y + 90, { width: contentWidth - 108, align: 'center' });

  y += 122;

  const labels = getReportLabels(schoolInfo?.country);

  // Student info card
  drawCard(doc, contentX, y, contentWidth, 102);
  doc.fillColor('#4a5a70').font('Helvetica').fontSize(10);
  doc.text(`${labels.classLabel}:`, contentX + 20, y + 20);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(exam.class_name, contentX + 86, y + 20);
  doc.fillColor('#4a5a70').font('Helvetica').text('Student Name:', contentX + 20, y + 44);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(student.name, contentX + 94, y + 44);
  doc.fillColor('#4a5a70').font('Helvetica').text(`${labels.teacherLabel}:`, contentX + 20, y + 68);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(formTeacherName || '-', contentX + 94, y + 68);
  doc.fillColor('#4a5a70').font('Helvetica').text(`${labels.termLabel}:`, contentX + 20, y + 88);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(`${exam.term} / ${exam.year}`, contentX + 126, y + 88);

  doc.fillColor('#4a5a70').font('Helvetica').text('Position in Class:', contentX + contentWidth / 2, y + 20);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(formatRank(studentRanking?.rank || 0), contentX + contentWidth / 2 + 78, y + 20);
  doc.fillColor('#4a5a70').font('Helvetica').text('Number of Students:', contentX + contentWidth / 2, y + 44);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(String(rankings.length), contentX + contentWidth / 2 + 95, y + 44);

  y += 120;

  const componentWeight = Number(exam.component_weight || 0);
  const currentWeight = Number(exam.current_weight || 100);
  const isMidterm = String(exam.type || '').toLowerCase() === 'midterm';
  const hasComponent = Boolean(exam.component_exam_id);
  const componentLabel = exam.component_exam_name || 'CAT';
  const currentLabel = exam.name || 'Current Exam';
  const weightedComponentExamMax = Math.max(1, Number(exam.component_exam_max_score || 100));
  const currentExamMax = Math.max(1, Number(exam.max_score || 100));
  const caPercentLabel = componentWeight;
  const etPercentLabel = currentWeight;

  // Academic table card
  const columns = hasComponent
      ? [
        { key: 'subject', label: 'Subject', width: 95 },
        { key: 'ca', label: `C/A (${formatOneDecimal(caPercentLabel)}%)`, width: 70 },
        { key: 'exam', label: `E/T (${formatOneDecimal(etPercentLabel)}%)`, width: 70 },
        { key: 'final', label: 'Final Mark', width: 55 },
        { key: 'position', label: 'Position', width: 45 },
        ...(isMidterm ? [] : [{ key: 'grade', label: 'Grade', width: 45 }]),
        { key: 'remark', label: 'Remark', width: 75 },
        { key: 'signature', label: 'Signature', width: 65 }
      ]
    : [
        { key: 'subject', label: 'Subject', width: 95 },
        { key: 'score', label: 'Score', width: 70 },
        { key: 'position', label: 'Position', width: 45 },
        ...(isMidterm ? [] : [{ key: 'grade', label: 'Grade', width: 45 }]),
        { key: 'remark', label: 'Remark', width: 75 },
        { key: 'signature', label: 'Signature', width: 65 }
      ];
  const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const tableX = contentX + ((contentWidth - tableWidth) / 2);
  const tableRows = Math.max(1, results.length);
  const compact = tableRows > 10;
  const fixedAfterTable = compact ? 208 : 230;
  const rowHeight = getAdaptiveRowHeight(doc, y, tableRows, fixedAfterTable, compact ? 9 : 11, compact ? 17 : 19);
  const tableHeight = rowHeight * (tableRows + 1);

  drawCard(doc, contentX, y, contentWidth, tableHeight + 18);
  drawRowBackground(doc, tableX, y + 10, tableWidth, rowHeight, '#f4f7fc');

  let colX = tableX;
  doc.fillColor('#516279').font('Helvetica-Bold').fontSize(9);
  columns.forEach((column) => {
    doc.text(column.label, colX + 4, y + 20, { width: column.width - 8, align: 'left' });
    colX += column.width;
  });

  const rowStartY = y + 10 + rowHeight;
  for (let row = 0; row < tableRows; row++) {
    const rowY = rowStartY + row * rowHeight;
    drawRowBackground(doc, tableX, rowY, tableWidth, rowHeight, row % 2 === 0 ? '#ffffff' : '#fafbfd');
    doc.strokeColor('#e2e8f0').lineWidth(0.6).moveTo(tableX, rowY).lineTo(tableX + tableWidth, rowY).stroke();

    const result = results[row];
    if (!result) continue;

    const gradeInfo = getGrade(result.score, result.grading_system || exam.grading_system);
    const subjectRank = subjectRankMaps.get(result.subject_id)?.get(studentId) || 0;
    const gradeDisplay = isMidterm
      ? '-'
      : (exam.grading_system === 'msce' ? String(result.points ?? gradeInfo.points ?? '-') : (result.grade || gradeInfo.grade));
    const remarkDisplay = result.remark || gradeInfo.remark || '';
    const caValue = formatWholeNumber((Number(result.component_score || 0) / weightedComponentExamMax) * componentWeight);
    const currentValue = formatWholeNumber((Number(result.current_score ?? result.score) / currentExamMax) * currentWeight);

    const values = hasComponent
      ? [
          result.subject_name,
          caValue,
          currentValue,
          formatWholeNumber(result.score),
          subjectRank > 0 ? formatRank(subjectRank) : '-',
          ...(isMidterm ? [] : [gradeDisplay]),
          remarkDisplay,
          String(subjectTeacherMap.get(result.subject_id) || '__________')
        ]
      : [
          result.subject_name,
          formatWholeNumber(result.score),
          subjectRank > 0 ? formatRank(subjectRank) : '-',
          ...(isMidterm ? [] : [gradeDisplay]),
          remarkDisplay,
          String(subjectTeacherMap.get(result.subject_id) || '__________')
        ];

    colX = tableX;
    doc.fillColor('#0f172a').font('Helvetica').fontSize(10);
    values.forEach((value, index) => {
      const align = index > 0 && index < (hasComponent ? (isMidterm ? 5 : 6) : (isMidterm ? 3 : 4)) ? 'center' : 'left';
      doc.text(String(value), colX + 4, rowY + 4, { width: columns[index].width - 8, align });
      colX += columns[index].width;
    });
  }

  const gapAfterTable = compact ? 22 : 26;
  y += tableHeight + gapAfterTable;

  // Legend + Summary cards
  const split = 10;
  const blockWidth = (contentWidth - split) / 2;
  const summaryBlockHeight = compact ? 102 : 112;
  drawCard(doc, contentX, y, blockWidth, summaryBlockHeight);
  drawCard(doc, contentX + blockWidth + split, y, blockWidth, summaryBlockHeight);

  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text('Grading Key', contentX + 14, y + 12);
  doc.fillColor('#0f172a').font('Helvetica').fontSize(8);

  if (isMidterm) {
    doc.text('Mid-term reports are ranking-only.', contentX + 14, y + 48, { width: blockWidth - 24, align: 'center' });
  } else {
    let legendY = y + 30;
    criteria.forEach((item) => {
      const text = exam.grading_system === 'msce'
        ? `${formatWholeNumber(item.min_score)}-${formatWholeNumber(item.max_score)}: ${formatPoints(item.points)} pt`
        : `${formatWholeNumber(item.min_score)}-${formatWholeNumber(item.max_score)}: ${item.grade}`;
      if (legendY > y + (compact ? 88 : 96)) return;
      doc.text(text, contentX + 14, legendY, { width: blockWidth - 24 });
      legendY += 12;
    });
  }

  const summaryX = contentX + blockWidth + split + 14;
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text('Summary & Remarks', summaryX, y + 12, { width: blockWidth - 28, align: 'center' });
  doc.fillColor('#4a5a70').font('Helvetica').fontSize(10);
  doc.text('Total Marks:', summaryX, y + 32);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(formatOneDecimal(totalScore), summaryX + 72, y + 32);

  if (!isMidterm && exam.grading_system === 'msce') {
    doc.fillColor('#4a5a70').font('Helvetica').text('Overall Points:', summaryX, y + 54);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(formatPoints(studentRanking?.totalPoints), summaryX + 78, y + 54);
  } else if (!isMidterm) {
    doc.fillColor('#4a5a70').font('Helvetica').text('Overall Grade:', summaryX, y + 54);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(`${overallGrade.grade}`, summaryX + 74, y + 54);
  } else {
    doc.fillColor('#4a5a70').font('Helvetica').text('Overall Grade:', summaryX, y + 54);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text('N/A (Mid Term)', summaryX + 74, y + 54);
  }

  doc.fillColor('#4a5a70').font('Helvetica').text('Remarks:', summaryX, y + 76);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(passFail.status, summaryX + 98, y + 76);

  y += compact ? 112 : 122;

  // Footer card
  drawCard(doc, contentX, y, contentWidth, 92);
  doc.fillColor('#4a5a70').font('Helvetica').fontSize(10);
  if (!isMidterm) {
    doc.text(`Next Term Opening Date: ${formatDisplayDate(schoolInfo.opening_date) || '____________________'}`, contentX + 14, y + 20);
    doc.text(`School Fees: ${schoolInfo.school_fees || '____________________'}`, contentX + 14, y + 44);
    doc.text(`Head Teacher Name: ${schoolInfo.headteacher_name || '____________________'}`, contentX + 14, y + 68);
  } else {
    doc.text(`Head Teacher Name: ${schoolInfo.headteacher_name || '____________________'}`, contentX + 14, y + 44);
  }

  const footerRightX = contentX + contentWidth / 2;
  drawHeadteacherSignature(doc, schoolInfo.headteacher_signature, footerRightX, y + 20, contentWidth / 2 - 16);

  doc.end();
});

// Download all student report cards for a class exam as a single PDF
router.get('/class/:classId/exam/:examId/student-reports/pdf', (req, res) => {
  const { classId, examId } = req.params;

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ? AND e.class_id = ?
  `).get(examId, classId);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, classId)) return;

  const rankings = rankStudentsByExam(examId);
  const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
  const formTeacherName = getFormTeacherName(exam.class_id);
  const logoPath = resolveLogoPath(schoolInfo?.logo);
  const criteria = db.prepare(`
    SELECT grade, min_score, max_score, points, remark
    FROM grade_criteria
    WHERE system = ?
    ORDER BY min_score DESC
  `).all(exam.grading_system);
  const classSubjects = db.prepare(`
    SELECT id, teacher_name
    FROM subjects
    WHERE class_id = ?
  `).all(exam.class_id);
  const subjectTeacherMap = new Map(classSubjects.map((row) => [row.id, row.teacher_name || '']));

  const allScores = [];
  rankings.forEach((entry) => {
    const r = calculateStudentResults(examId, entry.student.id);
    r.results.forEach((subjectRow) => {
      allScores.push({
        student_id: entry.student.id,
        subject_id: subjectRow.subject_id,
        score: subjectRow.score
      });
    });
  });
  const subjectRankMaps = buildSubjectRankMaps(allScores);

  const componentWeight = Number(exam.component_weight || 0);
  const currentWeight = Number(exam.current_weight || 100);
  const isMidterm = String(exam.type || '').toLowerCase() === 'midterm';
  const hasComponent = Boolean(exam.component_exam_id);
  const componentLabel = exam.component_exam_name || 'CAT';
  const currentLabel = exam.name || 'Current Exam';
  const weightedComponentExamMax = Math.max(1, Number(exam.component_exam_max_score || 100));
  const currentExamMax = Math.max(1, Number(exam.max_score || 100));
  const caPercentLabel = componentWeight;
  const etPercentLabel = currentWeight;

  const customDoc = new PDFDocument({ margin: 24, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.class_name}_${exam.name}_student_reports.pdf"`);
  customDoc.pipe(res);

  rankings.forEach((entry, index) => {
    if (index > 0) customDoc.addPage();

    const student = entry.student;
    const calculated = calculateStudentResults(examId, student.id);
    const results = calculated.results
      .slice()
      .sort((a, b) => (a.subject_name || '').localeCompare(b.subject_name || ''));
    const averageScore = calculated.averageScore;
    const totalScore = calculated.totalScore;
    const overallGrade = getOverallGradeWithEnglishRule(exam, averageScore, results);
    const passFail = getPassFailRemark(exam, results);

    renderStudentReportCardPage({
      doc: customDoc,
      schoolInfo,
      student,
      exam,
      rankingsCount: rankings.length,
      studentRank: entry.rank || 0,
      totalPoints: entry.totalPoints,
      formTeacherName,
      logoPath,
      criteria,
      results,
      totalScore,
      overallGrade,
      passFail,
      subjectTeacherMap,
      subjectRankMaps,
      studentId: student.id,
    });
  });

  customDoc.end();
});

router.get('/class/:classId/exam/:examId/student-reports/zip', async (req, res, next) => {
  try {
    const { classId, examId } = req.params;

    const exam = db.prepare(`
      SELECT e.*, c.name as class_name, c.year as class_year,
             ce.name as component_exam_name,
             ce.max_score as component_exam_max_score,
             ce.type as component_exam_type
      FROM exams e
      JOIN classes c ON e.class_id = c.id
      LEFT JOIN exams ce ON e.component_exam_id = ce.id
      WHERE e.id = ? AND e.class_id = ?
    `).get(examId, classId);

    if (!exam) {
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (!ensureClassAccess(req, res, classId)) return;

    const rankings = rankStudentsByExam(examId);
    const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
    const formTeacherName = getFormTeacherName(exam.class_id);
    const logoPath = resolveLogoPath(schoolInfo?.logo);
    const criteria = db.prepare(`
      SELECT grade, min_score, max_score, points, remark
      FROM grade_criteria
      WHERE system = ?
      ORDER BY min_score DESC
    `).all(exam.grading_system);
    const classSubjects = db.prepare(`
      SELECT id, teacher_name
      FROM subjects
      WHERE class_id = ?
    `).all(exam.class_id);
    const subjectTeacherMap = new Map(classSubjects.map((row) => [row.id, row.teacher_name || '']));

    const allScores = [];
    rankings.forEach((entry) => {
      const r = calculateStudentResults(examId, entry.student.id);
      r.results.forEach((subjectRow) => {
        allScores.push({
          student_id: entry.student.id,
          subject_id: subjectRow.subject_id,
          score: subjectRow.score,
        });
      });
    });
    const subjectRankMaps = buildSubjectRankMaps(allScores);

    const zipBuffer = await buildStudentReportsZip({
      rankings,
      exam,
      schoolInfo,
      formTeacherName,
      logoPath,
      criteria,
      subjectTeacherMap,
      buildReportContext: (entry) => {
        const calculated = calculateStudentResults(examId, entry.student.id);
        const results = calculated.results
          .slice()
          .sort((a, b) => (a.subject_name || '').localeCompare(b.subject_name || ''));
        const averageScore = calculated.averageScore;
        const totalScore = calculated.totalScore;
        const overallGrade = getOverallGradeWithEnglishRule(exam, averageScore, results);
        const passFail = getPassFailRemark(exam, results);
        return {
          studentRank: entry.rank,
          totalPoints: entry.totalPoints,
          results,
          totalScore,
          overallGrade,
          passFail,
          subjectRankMaps,
        };
      },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${exam.class_name}_${exam.name}_student_reports.zip"`);
    res.send(zipBuffer);
  } catch (error) {
    next(error);
  }
});

  return;

  const doc = new PDFDocument({ margin: 24, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.class_name}_${exam.name}_student_reports.pdf"`);
  doc.pipe(res);

  rankings.forEach((entry, index) => {
    if (index > 0) doc.addPage();

    const student = entry.student;
    const calculated = calculateStudentResults(examId, student.id);
    const results = calculated.results
      .slice()
      .sort((a, b) => (a.subject_name || '').localeCompare(b.subject_name || ''));
    const averageScore = calculated.averageScore;
    const totalScore = calculated.totalScore;
    const overallGrade = getOverallGradeWithEnglishRule(exam, averageScore, results);
    const passFail = getPassFailRemark(exam, results);

    const pageWidth = doc.page.width;
    const contentX = 24;
    const contentWidth = pageWidth - 48;
    let y = 24;

    drawCard(doc, contentX, y, contentWidth, 112);
    if (logoPath) {
      doc.image(logoPath, contentX + 14, y + 16, { fit: [72, 72] });
    }
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
      .text(schoolInfo.name || 'SCHOOL', contentX + 94, y + 18, { width: contentWidth - 108, align: 'center' });
    doc.fillColor('#5b6b80').font('Helvetica').fontSize(11)
      .text(schoolInfo.address || '', contentX + 94, y + 46, { width: contentWidth - 108, align: 'center' });
    doc.text(`Tel: ${schoolInfo.phone || '-'} | Email: ${schoolInfo.email || '-'}`, contentX + 94, y + 64, {
      width: contentWidth - 108,
      align: 'center'
    });
    const headerMotto = String(schoolInfo.motto || '').trim();
    if (headerMotto) {
      doc.font('Helvetica-Oblique').text(headerMotto, contentX + 94, y + 78, {
        width: contentWidth - 108,
        align: 'center',
        lineBreak: false,
        ellipsis: true
      });
    }
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13)
      .text('SCHOOL REPORT', contentX + 94, y + 90, { width: contentWidth - 108, align: 'center' });

    y += 122;
    const labels = getReportLabels(schoolInfo?.country);
    drawCard(doc, contentX, y, contentWidth, 102);
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(10);
    doc.text(`${labels.classLabel}:`, contentX + 20, y + 20);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(exam.class_name, contentX + 86, y + 20);
    doc.fillColor('#4a5a70').font('Helvetica').text('Student Name:', contentX + 20, y + 44);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(student.name, contentX + 94, y + 44);
    doc.fillColor('#4a5a70').font('Helvetica').text(`${labels.teacherLabel}:`, contentX + 20, y + 68);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(formTeacherName || '-', contentX + 94, y + 68);
    doc.fillColor('#4a5a70').font('Helvetica').text(`${labels.termLabel}:`, contentX + 20, y + 88);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(`${exam.term} / ${exam.year}`, contentX + 126, y + 88);

    doc.fillColor('#4a5a70').font('Helvetica').text('Position in Class:', contentX + contentWidth / 2, y + 20);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(formatRank(entry.rank || 0), contentX + contentWidth / 2 + 78, y + 20);
    doc.fillColor('#4a5a70').font('Helvetica').text('Number of Students:', contentX + contentWidth / 2, y + 44);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(String(rankings.length), contentX + contentWidth / 2 + 95, y + 44);

    y += 120;
    const columns = hasComponent
      ? [
          { key: 'subject', label: 'Subject', width: 95 },
          { key: 'ca', label: `C/A (${formatOneDecimal(caPercentLabel)}%)`, width: 70 },
          { key: 'exam', label: `E/T (${formatOneDecimal(etPercentLabel)}%)`, width: 70 },
          { key: 'final', label: 'Final Mark', width: 55 },
          { key: 'position', label: 'Position', width: 45 },
          ...(isMidterm ? [] : [{ key: 'grade', label: 'Grade', width: 45 }]),
          { key: 'remark', label: 'Remark', width: 75 },
          { key: 'signature', label: 'Signature', width: 65 }
        ]
      : [
          { key: 'subject', label: 'Subject', width: 95 },
          { key: 'score', label: 'Score', width: 70 },
          { key: 'position', label: 'Position', width: 45 },
          ...(isMidterm ? [] : [{ key: 'grade', label: 'Grade', width: 45 }]),
          { key: 'remark', label: 'Remark', width: 75 },
          { key: 'signature', label: 'Signature', width: 65 }
        ];
    const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);
    const tableX = contentX + ((contentWidth - tableWidth) / 2);
    const tableRows = Math.max(1, results.length);
    const compact = tableRows > 10;
    const fixedAfterTable = compact ? 208 : 230;
    const rowHeight = getAdaptiveRowHeight(doc, y, tableRows, fixedAfterTable, compact ? 9 : 11, compact ? 17 : 19);
    const tableHeight = rowHeight * (tableRows + 1);

    drawCard(doc, contentX, y, contentWidth, tableHeight + 18);
    drawRowBackground(doc, tableX, y + 10, tableWidth, rowHeight, '#f4f7fc');
    let colX = tableX;
    doc.fillColor('#516279').font('Helvetica-Bold').fontSize(9);
    columns.forEach((column) => {
      doc.text(column.label, colX + 4, y + 20, { width: column.width - 8, align: 'left' });
      colX += column.width;
    });
    const rowStartY = y + 10 + rowHeight;
    for (let row = 0; row < tableRows; row++) {
      const rowY = rowStartY + row * rowHeight;
      drawRowBackground(doc, tableX, rowY, tableWidth, rowHeight, row % 2 === 0 ? '#ffffff' : '#fafbfd');
      doc.strokeColor('#e2e8f0').lineWidth(0.6).moveTo(tableX, rowY).lineTo(tableX + tableWidth, rowY).stroke();
      const result = results[row];
      if (!result) continue;
      const gradeInfo = getGrade(result.score, result.grading_system || exam.grading_system);
      const subjectRank = subjectRankMaps.get(result.subject_id)?.get(student.id) || 0;
      const gradeDisplay = isMidterm
        ? '-'
        : (exam.grading_system === 'msce' ? String(result.points ?? gradeInfo.points ?? '-') : (result.grade || gradeInfo.grade));
      const remarkDisplay = result.remark || gradeInfo.remark || '';
      const caValue = formatWholeNumber((Number(result.component_score || 0) / weightedComponentExamMax) * componentWeight);
      const currentValue = formatWholeNumber((Number(result.current_score ?? result.score) / currentExamMax) * currentWeight);
      const values = hasComponent
        ? [
            result.subject_name,
            caValue,
            currentValue,
            formatWholeNumber(result.score),
            subjectRank > 0 ? formatRank(subjectRank) : '-',
            ...(isMidterm ? [] : [gradeDisplay]),
            remarkDisplay,
            String(subjectTeacherMap.get(result.subject_id) || '__________')
          ]
        : [
            result.subject_name,
            formatWholeNumber(result.score),
            subjectRank > 0 ? formatRank(subjectRank) : '-',
            ...(isMidterm ? [] : [gradeDisplay]),
            remarkDisplay,
            String(subjectTeacherMap.get(result.subject_id) || '__________')
          ];
      colX = tableX;
      doc.fillColor('#0f172a').font('Helvetica').fontSize(10);
      values.forEach((value, colIndex) => {
        const align = colIndex > 0 && colIndex < (hasComponent ? (isMidterm ? 5 : 6) : (isMidterm ? 3 : 4)) ? 'center' : 'left';
        doc.text(String(value), colX + 4, rowY + 4, { width: columns[colIndex].width - 8, align });
        colX += columns[colIndex].width;
      });
    }

    const gapAfterTable = compact ? 22 : 26;
    y += tableHeight + gapAfterTable;
    const split = 10;
    const blockWidth = (contentWidth - split) / 2;
    const summaryBlockHeight = compact ? 102 : 112;
    drawCard(doc, contentX, y, blockWidth, summaryBlockHeight);
    drawCard(doc, contentX + blockWidth + split, y, blockWidth, summaryBlockHeight);
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text('Grading Key', contentX + 14, y + 12);
    doc.fillColor('#0f172a').font('Helvetica').fontSize(8);
    if (isMidterm) {
      doc.text('Mid-term reports are ranking-only.', contentX + 14, y + 48, { width: blockWidth - 24, align: 'center' });
    } else {
      let legendY = y + 30;
      criteria.forEach((item) => {
        const text = exam.grading_system === 'msce'
          ? `${formatWholeNumber(item.min_score)}-${formatWholeNumber(item.max_score)}: ${formatPoints(item.points)} pt`
          : `${formatWholeNumber(item.min_score)}-${formatWholeNumber(item.max_score)}: ${item.grade}`;
        if (legendY > y + (compact ? 88 : 96)) return;
        doc.text(text, contentX + 14, legendY, { width: blockWidth - 24 });
        legendY += 12;
      });
    }

    const summaryX = contentX + blockWidth + split + 14;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text('Summary & Remarks', summaryX, y + 12, { width: blockWidth - 28, align: 'center' });
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(10);
    doc.text('Total Marks:', summaryX, y + 32);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(formatOneDecimal(totalScore), summaryX + 72, y + 32);
    if (!isMidterm && exam.grading_system === 'msce') {
      doc.fillColor('#4a5a70').font('Helvetica').text('Overall Points:', summaryX, y + 54);
      doc.fillColor('#0f172a').font('Helvetica-Bold').text(formatPoints(entry.totalPoints), summaryX + 78, y + 54);
    } else if (!isMidterm) {
      doc.fillColor('#4a5a70').font('Helvetica').text('Overall Grade:', summaryX, y + 54);
      doc.fillColor('#0f172a').font('Helvetica-Bold').text(`${overallGrade.grade}`, summaryX + 74, y + 54);
    } else {
      doc.fillColor('#4a5a70').font('Helvetica').text('Overall Grade:', summaryX, y + 54);
      doc.fillColor('#0f172a').font('Helvetica-Bold').text('N/A (Mid Term)', summaryX + 74, y + 54);
    }

    doc.fillColor('#4a5a70').font('Helvetica').text('Remarks:', summaryX, y + 76);
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(passFail.status, summaryX + 98, y + 76);

    y += compact ? 112 : 122;
    drawCard(doc, contentX, y, contentWidth, 92);
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(10);
    if (!isMidterm) {
      doc.text(`Next Term Opening Date: ${formatDisplayDate(schoolInfo.opening_date) || '____________________'}`, contentX + 14, y + 20);
      doc.text(`School Fees: ${schoolInfo.school_fees || '____________________'}`, contentX + 14, y + 44);
      doc.text(`Head Teacher Name: ${schoolInfo.headteacher_name || '____________________'}`, contentX + 14, y + 68);
    } else {
      doc.text(`Head Teacher Name: ${schoolInfo.headteacher_name || '____________________'}`, contentX + 14, y + 44);
    }
    const footerRightX = contentX + contentWidth / 2;
    drawHeadteacherSignature(doc, schoolInfo.headteacher_signature, footerRightX, y + 20, contentWidth / 2 - 16);
  });

  doc.end();
});

// Get class results summary
router.get('/class/:classId/exam/:examId', (req, res) => {
  const { classId, examId } = req.params;

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ? AND e.class_id = ?
  `).get(examId, classId);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, classId)) return;

  const rankings = rankStudentsByExam(examId);
  const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
  const formTeacherName = getFormTeacherName(exam.class_id);

  // Get subjects
  const subjects = db.prepare(
    'SELECT * FROM subjects WHERE class_id = ? ORDER BY name ASC'
  ).all(classId);

  // Calculate class statistics
  const allResults = db.prepare(`
    SELECT er.*, s.name as student_name
    FROM exam_results er
    JOIN students s ON er.student_id = s.id
    WHERE er.exam_id = ?
  `).all(examId);

  const classAverage = rankings.length > 0
    ? rankings.reduce((sum, r) => sum + r.averageScore, 0) / rankings.length
    : 0;

  const highestAverage = rankings.length > 0 ? rankings[0].averageScore : 0;
  const lowestAverage = rankings.length > 0 ? rankings[rankings.length - 1].averageScore : 0;

  res.json({
    report: {
      school: schoolInfo,
      exam,
      formTeacherName,
      weighting: {
        componentExamName: exam.component_exam_name || null,
        componentWeight: Number(exam.component_weight || 0),
        currentWeight: Number(exam.current_weight || 100)
      },
      subjects,
      rankings,
      statistics: {
        totalStudents: rankings.length,
        classAverage: Math.round(classAverage),
        highestAverage: Math.round(highestAverage),
        lowestAverage: Math.round(lowestAverage)
      }
    }
  });
});

// Download class results as Excel
router.get('/class/:classId/exam/:examId/excel', (req, res) => {
  const { classId, examId } = req.params;

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ? AND e.class_id = ?
  `).get(examId, classId);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, classId)) return;

  const subjects = db.prepare(
    'SELECT * FROM subjects WHERE class_id = ? ORDER BY name ASC'
  ).all(classId);

  const rankings = rankStudentsByExam(examId);

  // Build Excel data
  const headers = ['Rank', 'Student Name', 'Admission No', ...subjects.map(s => s.name), 'Total', 'Average', 'Grade'];
  
  const rows = rankings.map(r => {
    const studentResults = calculateStudentResults(examId, r.student.id).results;
    const resultMap = new Map(studentResults.map(res => [res.subject_id, res.score]));
    const overallGrade = getOverallGradeWithEnglishRule(exam, r.averageScore, studentResults);

    return [
      r.rank,
      r.student.name,
      r.student.admission_number || '',
      ...subjects.map(s => {
        const score = resultMap.get(s.id);
        return score !== undefined ? formatWholeNumber(score) : '';
      }),
      formatWholeNumber(r.totalScore ?? 0),
      formatWholeNumber(r.averageScore),
      overallGrade.grade
    ];
  });

  const ws = xlsx.utils.aoa_to_sheet([headers, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Results');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.class_name}_${exam.name}_results.xlsx"`);
  res.send(buffer);
});

// Download class results as PDF
router.get('/class/:classId/exam/:examId/pdf', (req, res) => {
  const { classId, examId } = req.params;

  const exam = db.prepare(`
    SELECT e.*, c.name as class_name, c.year as class_year,
           ce.name as component_exam_name,
           ce.max_score as component_exam_max_score,
           ce.type as component_exam_type
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    LEFT JOIN exams ce ON e.component_exam_id = ce.id
    WHERE e.id = ? AND e.class_id = ?
  `).get(examId, classId);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (!ensureClassAccess(req, res, classId)) return;

  const subjects = db.prepare(
    'SELECT * FROM subjects WHERE class_id = ? ORDER BY name ASC'
  ).all(classId);

  const rankings = rankStudentsByExam(examId);
  const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
  const logoPath = resolveLogoPath(schoolInfo?.logo);

  const doc = new PDFDocument({ margin: 20, size: 'A4', layout: 'landscape' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${exam.class_name}_${exam.name}_results.pdf"`);

  doc.pipe(res);
  renderPaginatedClassResultsPdf(doc, {
    schoolInfo,
    exam,
    subjects,
    rankings,
    logoPath,
    examId,
    getOverallGradeWithEnglishRule,
  });
  doc.end();
});

export default router;





