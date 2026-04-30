import { getReportLabels } from './education.js';
import { formatRank, getGrade } from './grading.js';
import { DEFAULT_REPORT_CARD_DESIGN, resolveStoredReportCardDesign } from './reportCardDesign.js';

function formatOneDecimal(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(1) : '-';
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

function drawCard(doc, rect, design) {
  doc.save();
  doc.roundedRect(rect.x, rect.y, rect.width, rect.height, 12);
  if (design.page.showCardBorders) {
    doc.fillAndStroke('#ffffff', '#d9dee7');
  } else {
    doc.fill('#ffffff');
  }
  doc.restore();
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

function resolveActiveDesign(schoolInfo) {
  const stored = resolveStoredReportCardDesign(schoolInfo?.report_card_design);
  return stored.enabled ? stored : DEFAULT_REPORT_CARD_DESIGN;
}

function toRect(doc, block) {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  return {
    x: (Number(block?.x || 0) / 100) * pageWidth,
    y: (Number(block?.y || 0) / 100) * pageHeight,
    width: (Number(block?.width || 0) / 100) * pageWidth,
    height: (Number(block?.height || 0) / 100) * pageHeight,
  };
}

function getTableColumns({ hasComponent, isMidterm, useEndTermComposite, caPercentLabel, etPercentLabel, design }) {
  const columns = [
    { key: 'subject', label: 'Subject', weight: hasComponent ? 2.4 : 2.5, align: 'left' },
  ];

  if (hasComponent) {
    columns.push(
      { key: 'ca', label: `C/A (${formatOneDecimal(caPercentLabel)}%)`, weight: 1.1, align: 'center' },
      { key: 'exam', label: `E/T (${formatOneDecimal(etPercentLabel)}%)`, weight: 1.1, align: 'center' },
      { key: 'final', label: useEndTermComposite ? 'Final Mark (100%)' : 'Final Mark', weight: 1.1, align: 'center' },
    );
  } else {
    columns.push({ key: 'score', label: 'Score', weight: 1.1, align: 'center' });
  }

  if (design.features.showSubjectPosition) {
    columns.push({ key: 'position', label: 'Position', weight: 0.9, align: 'center' });
  }

  if (!isMidterm) {
    columns.push({ key: 'grade', label: 'Grade', weight: 0.9, align: 'center' });
  }

  columns.push({ key: 'remark', label: 'Remark', weight: 1.4, align: 'left' });

  if (design.features.showSubjectSignature) {
    columns.push({ key: 'signature', label: 'Signature', weight: 1.2, align: 'left' });
  }

  return columns;
}

function drawTable(doc, rect, columns, rows, accentColor) {
  const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0);
  const columnWidths = columns.map((column) => (column.weight / totalWeight) * rect.width);
  const headerHeight = Math.max(18, Math.min(26, rect.height * 0.16));
  const rowHeight = Math.max(8, Math.min(18, (rect.height - headerHeight - 6) / Math.max(1, rows.length)));

  doc.save();
  doc.roundedRect(rect.x, rect.y, rect.width, rect.height, 12).clip();
  doc.rect(rect.x, rect.y, rect.width, rect.height).fill('#ffffff');
  doc.restore();

  doc.save();
  doc.roundedRect(rect.x, rect.y, rect.width, headerHeight, 12).fill('#f4f7fc');
  doc.restore();

  let x = rect.x;
  columns.forEach((column, index) => {
    const width = columnWidths[index];
    doc.fillColor('#516279').font('Helvetica-Bold').fontSize(8.5).text(column.label, x + 4, rect.y + 6, {
      width: width - 8,
      align: column.align,
    });
    x += width;
  });

  rows.forEach((row, rowIndex) => {
    const y = rect.y + headerHeight + rowIndex * rowHeight;
    doc.save();
    doc.rect(rect.x, y, rect.width, rowHeight).fill(rowIndex % 2 === 0 ? '#ffffff' : '#fafbfd');
    doc.restore();
    doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(rect.x, y).lineTo(rect.x + rect.width, y).stroke();

    let columnX = rect.x;
    columns.forEach((column, index) => {
      const width = columnWidths[index];
      const value = String(row[column.key] ?? '');
      doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5).text(value, columnX + 4, y + 3, {
        width: width - 8,
        align: column.align,
        ellipsis: true,
      });
      columnX += width;
    });
  });

  doc.save();
  doc.roundedRect(rect.x, rect.y, rect.width, rect.height, 12);
  doc.lineWidth(0.8).strokeColor(accentColor || '#d9dee7').stroke();
  doc.restore();
}

function renderHeader(doc, rect, { schoolInfo, logoPath, design }) {
  drawCard(doc, rect, design);

  const innerX = rect.x + 14;
  const innerY = rect.y + 12;
  const logoSize = Math.min(60, rect.height - 24);
  let textX = innerX;
  let textWidth = rect.width - 28;

  if (design.features.showLogo && logoPath) {
    try {
      doc.image(logoPath, innerX, rect.y + Math.max(10, (rect.height - logoSize) / 2), { fit: [logoSize, logoSize] });
      textX += logoSize + 12;
      textWidth -= logoSize + 12;
    } catch {
      // Ignore logo rendering failures.
    }
  }

  doc.fillColor(design.page.accentColor).font('Helvetica-Bold').fontSize(16).text(
    schoolInfo.name || 'SCHOOL',
    textX,
    innerY,
    { width: textWidth, align: 'center', ellipsis: true }
  );

  doc.fillColor('#5b6b80').font('Helvetica').fontSize(10).text(
    schoolInfo.address || '',
    textX,
    innerY + 24,
    { width: textWidth, align: 'center', ellipsis: true }
  );

  if (design.features.showContacts) {
    doc.text(
      `Tel: ${schoolInfo.phone || '-'} | Email: ${schoolInfo.email || '-'}`,
      textX,
      innerY + 38,
      { width: textWidth, align: 'center', ellipsis: true }
    );
  }

  if (design.features.showMotto) {
    const headerMotto = String(schoolInfo.motto || '').trim();
    if (headerMotto) {
      doc.font('Helvetica-Oblique').fontSize(9.5).text(headerMotto, textX, innerY + 52, {
        width: textWidth,
        align: 'center',
        ellipsis: true,
      });
    }
  }

  doc.fillColor(design.page.accentColor).font('Helvetica-Bold').fontSize(12).text(
    design.text.reportTitle,
    textX,
    rect.y + rect.height - 22,
    { width: textWidth, align: 'center', ellipsis: true }
  );
}

function renderStudentInfo(doc, rect, { schoolInfo, student, exam, formTeacherName, rankingsCount, studentRank, design }) {
  drawCard(doc, rect, design);
  const labels = getReportLabels(schoolInfo?.country);
  const leftItems = [
    { label: labels.classLabel, value: exam.class_name || '-' },
    { label: 'Student Name', value: student.name || '-' },
    ...(design.features.showTeacherName ? [{ label: labels.teacherLabel, value: formTeacherName || '-' }] : []),
    { label: labels.termLabel, value: `${exam.term || '-'} / ${exam.year || '-'}` },
  ];
  const rightItems = [
    ...(design.features.showStudentPosition ? [{ label: 'Position in Class', value: formatRank(studentRank || 0) }] : []),
    ...(design.features.showStudentCount ? [{ label: 'Number of Students', value: String(rankingsCount || 0) }] : []),
  ];

  const lineHeight = Math.max(12, Math.min(18, (rect.height - 22) / Math.max(leftItems.length, rightItems.length, 2)));
  const leftX = rect.x + 16;
  const rightX = rect.x + rect.width / 2 + 10;

  leftItems.forEach((item, index) => {
    const y = rect.y + 14 + index * lineHeight;
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(9.5).text(`${item.label}:`, leftX, y, { width: 82 });
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(item.value, leftX + 76, y, {
      width: rect.width / 2 - 92,
      ellipsis: true,
    });
  });

  rightItems.forEach((item, index) => {
    const y = rect.y + 14 + index * lineHeight;
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(9.5).text(`${item.label}:`, rightX, y, { width: 86 });
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(item.value, rightX + 82, y, {
      width: rect.width / 2 - 102,
      ellipsis: true,
    });
  });
}

function renderGradingKey(doc, rect, { criteria, exam, design, isMidterm }) {
  drawCard(doc, rect, design);
  doc.fillColor(design.page.accentColor).font('Helvetica-Bold').fontSize(11).text(
    design.text.gradingKeyTitle,
    rect.x + 12,
    rect.y + 10,
    { width: rect.width - 24, ellipsis: true }
  );

  if (isMidterm) {
    doc.fillColor('#0f172a').font('Helvetica').fontSize(9.5).text(
      'Mid-term reports are ranking-only.',
      rect.x + 12,
      rect.y + Math.max(28, rect.height / 2 - 6),
      { width: rect.width - 24, align: 'center' }
    );
    return;
  }

  const lineHeight = 11;
  const maxRows = Math.max(1, Math.floor((rect.height - 28) / lineHeight));
  criteria.slice(0, maxRows).forEach((item, index) => {
    const y = rect.y + 28 + index * lineHeight;
    const text = exam.grading_system === 'msce'
      ? `${formatOneDecimal(item.min_score)}-${formatOneDecimal(item.max_score)}: ${formatPoints(item.points)} pt`
      : `${formatOneDecimal(item.min_score)}-${formatOneDecimal(item.max_score)}: ${item.grade}`;
    doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5).text(text, rect.x + 12, y, {
      width: rect.width - 24,
      ellipsis: true,
    });
  });
}

function renderSummary(doc, rect, { exam, totalScore, totalPoints, overallGrade, passFail, design, isMidterm }) {
  drawCard(doc, rect, design);
  doc.fillColor(design.page.accentColor).font('Helvetica-Bold').fontSize(11).text(
    design.text.summaryTitle,
    rect.x + 12,
    rect.y + 10,
    { width: rect.width - 24, align: 'center', ellipsis: true }
  );

  const rows = [
    { label: 'Total Marks', value: formatOneDecimal(totalScore) },
  ];

  if (!isMidterm && exam.grading_system === 'msce' && design.features.showOverallPoints) {
    rows.push({ label: 'Overall Points', value: formatPoints(totalPoints) });
  } else if (!isMidterm && design.features.showOverallGrade) {
    rows.push({ label: 'Overall Grade', value: String(overallGrade?.grade || '-') });
  } else if (isMidterm && design.features.showOverallGrade) {
    rows.push({ label: 'Overall Grade', value: 'N/A (Mid Term)' });
  }

  if (design.features.showPassFailRemark) {
    rows.push({ label: 'Remarks', value: String(passFail?.status || '-') });
  }

  const lineHeight = Math.max(12, Math.min(18, (rect.height - 28) / Math.max(rows.length, 2)));
  rows.forEach((row, index) => {
    const y = rect.y + 28 + index * lineHeight;
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(9.5).text(`${row.label}:`, rect.x + 12, y, { width: 90 });
    doc.fillColor('#0f172a').font('Helvetica-Bold').text(row.value, rect.x + 90, y, {
      width: rect.width - 104,
      ellipsis: true,
    });
  });
}

function renderFooter(doc, rect, { schoolInfo, design }) {
  drawCard(doc, rect, design);
  const leftX = rect.x + 12;
  const lineHeight = 16;
  let rowIndex = 0;

  if (design.features.showOpeningDate) {
    doc.fillColor('#4a5a70').font('Helvetica').fontSize(9.5).text(
      `Next Term Opening Date: ${formatDisplayDate(schoolInfo.opening_date) || '____________________'}`,
      leftX,
      rect.y + 14 + rowIndex * lineHeight,
      { width: rect.width / 2 - 18, ellipsis: true }
    );
    rowIndex += 1;
  }

  if (design.features.showSchoolFees) {
    doc.text(
      `School Fees: ${schoolInfo.school_fees || '____________________'}`,
      leftX,
      rect.y + 14 + rowIndex * lineHeight,
      { width: rect.width / 2 - 18, ellipsis: true }
    );
    rowIndex += 1;
  }

  if (design.features.showHeadteacherName) {
    doc.text(
      `Head Teacher Name: ${schoolInfo.headteacher_name || '____________________'}`,
      leftX,
      rect.y + 14 + rowIndex * lineHeight,
      { width: rect.width / 2 - 18, ellipsis: true }
    );
  }

  if (design.features.showHeadteacherSignature) {
    drawHeadteacherSignature(
      doc,
      schoolInfo.headteacher_signature,
      rect.x + rect.width / 2 + 8,
      rect.y + 14,
      rect.width / 2 - 20
    );
  }
}

export function renderStudentReportCardPage({
  doc,
  schoolInfo,
  student,
  exam,
  rankingsCount,
  studentRank,
  totalPoints,
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
}) {
  const design = resolveActiveDesign(schoolInfo);
  const isMidterm = String(exam.type || '').toLowerCase() === 'midterm';
  const componentWeight = Number(exam.component_weight || 0);
  const currentWeight = Number(exam.current_weight || 100);
  const useEndTermComposite = String(exam.type || '').toLowerCase() === 'endterm'
    && String(exam.component_exam_type || '').toLowerCase() === 'midterm';
  const hasComponent = componentWeight > 0 && Boolean(exam.component_exam_name);
  const componentExamMax = Math.max(0, Number(exam.component_exam_max_score || 0));
  const remainingToHundred = Math.max(0, 100 - componentExamMax);
  const currentExamMax = Math.max(1, Number(exam.max_score || 100));
  const caPercentLabel = useEndTermComposite ? componentExamMax : componentWeight;
  const etPercentLabel = useEndTermComposite ? remainingToHundred : currentWeight;

  doc.save();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(design.page.backgroundColor || '#ffffff');
  doc.restore();

  const blocks = {
    header: toRect(doc, design.blocks.header),
    studentInfo: toRect(doc, design.blocks.studentInfo),
    table: toRect(doc, design.blocks.table),
    gradingKey: toRect(doc, design.blocks.gradingKey),
    summary: toRect(doc, design.blocks.summary),
    footer: toRect(doc, design.blocks.footer),
  };

  if (design.blocks.header.visible) {
    renderHeader(doc, blocks.header, { schoolInfo, logoPath, design });
  }

  if (design.blocks.studentInfo.visible) {
    renderStudentInfo(doc, blocks.studentInfo, {
      schoolInfo,
      student,
      exam,
      formTeacherName,
      rankingsCount,
      studentRank,
      design,
    });
  }

  if (design.blocks.table.visible) {
    const columns = getTableColumns({
      hasComponent,
      isMidterm,
      useEndTermComposite,
      caPercentLabel,
      etPercentLabel,
      design,
    });

    const rows = (results || []).map((result) => {
      const gradeInfo = getGrade(result.score, result.grading_system || exam.grading_system);
      const subjectRank = subjectRankMaps.get(result.subject_id)?.get(studentId) || 0;
      const caValue = useEndTermComposite
        ? Number(result.component_score || 0).toFixed(1)
        : ((Number(result.component_score || 0) * componentWeight) / 100).toFixed(1);
      const currentValue = useEndTermComposite
        ? ((Number(result.current_score || 0) / currentExamMax) * remainingToHundred).toFixed(1)
        : ((Number(result.current_score || result.score) * currentWeight) / 100).toFixed(1);

      return {
        subject: String(result.subject_name || ''),
        score: formatOneDecimal(result.score),
        ca: caValue,
        exam: currentValue,
        final: formatOneDecimal(result.score),
        position: subjectRank > 0 ? formatRank(subjectRank) : '-',
        grade: isMidterm
          ? '-'
          : (exam.grading_system === 'msce'
            ? String(result.points ?? gradeInfo.points ?? '-')
            : String(result.grade || gradeInfo.grade || '-')),
        remark: String(result.remark || gradeInfo.remark || ''),
        signature: String(subjectTeacherMap.get(result.subject_id) || '__________'),
      };
    });

    drawTable(doc, blocks.table, columns, rows, design.page.accentColor);
  }

  if (design.blocks.gradingKey.visible && design.features.showGradingKey) {
    renderGradingKey(doc, blocks.gradingKey, { criteria, exam, design, isMidterm });
  }

  if (design.blocks.summary.visible && design.features.showSummary) {
    renderSummary(doc, blocks.summary, {
      exam,
      totalScore,
      totalPoints,
      overallGrade,
      passFail,
      design,
      isMidterm,
    });
  }

  if (design.blocks.footer.visible && design.features.showFooter) {
    renderFooter(doc, blocks.footer, { schoolInfo, design });
  }
}
