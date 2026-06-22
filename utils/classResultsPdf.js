import { calculateStudentResults, getGrade, formatRank } from './grading.js';

function formatWholeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num)) : '-';
}

function formatPoints(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num)) : '-';
}

function drawCard(doc, x, y, width, height) {
  doc.save();
  doc.roundedRect(x, y, width, height, 10);
  doc.fillAndStroke('#ffffff', '#d9dee7');
  doc.restore();
}

function drawRowBackground(doc, x, y, width, height, color = '#ffffff') {
  doc.save();
  doc.rect(x, y, width, height).fill(color);
  doc.restore();
}

function buildColumns(subjects, exam, contentWidth) {
  const rankW = 58;
  const nameW = 190;
  const totalW = 70;
  const avgW = 65;
  const finalW = 70;
  const subjectW = Math.max(
    46,
    Math.min(80, (contentWidth - rankW - nameW - totalW - avgW - finalW) / Math.max(1, subjects.length)),
  );

  return [
    { label: 'Rank', width: rankW, align: 'left' },
    { label: 'Student Name', width: nameW, align: 'left' },
    ...subjects.map((subject) => ({
      label: subject.code || subject.name.toUpperCase().slice(0, 5),
      width: subjectW,
      align: 'center',
    })),
    { label: 'Total', width: totalW, align: 'center' },
    { label: 'Avg', width: avgW, align: 'center' },
    { label: exam.grading_system === 'msce' ? 'Points' : 'Grade', width: finalW, align: 'center' },
  ];
}

function countRowsForPage(doc, tableY, rowHeight, headerHeight, pageMargin) {
  const pageBottom = doc.page.height - pageMargin;
  const cardPadding = 22;
  const available = pageBottom - tableY - headerHeight - cardPadding;
  return Math.max(1, Math.floor(available / rowHeight));
}

function drawFullPageHeader(doc, { contentX, contentWidth, schoolInfo, exam, logoPath, margin }) {
  let y = margin;
  drawCard(doc, contentX, y, contentWidth, 92);
  if (logoPath) {
    try {
      doc.image(logoPath, contentX + 14, y + 12, { fit: [52, 52] });
    } catch {
      // Ignore logo rendering failures.
    }
  }
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
    .text(schoolInfo.name || 'SCHOOL', contentX + 78, y + 16, { width: contentWidth - 92 });
  doc.fillColor('#5b6b80').font('Helvetica').fontSize(11)
    .text(`${exam.class_name} - ${exam.name}`, contentX + 78, y + 44, { width: contentWidth - 92 });
  return y + 106;
}

function drawContinuationHeader(doc, { contentX, contentWidth, schoolInfo, exam, margin }) {
  const y = margin;
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13)
    .text(schoolInfo.name || 'SCHOOL', contentX, y, { width: contentWidth });
  doc.fillColor('#5b6b80').font('Helvetica').fontSize(10)
    .text(`${exam.class_name} - ${exam.name} (continued)`, contentX, y + 16, { width: contentWidth });
  return y + 38;
}

function drawTableSection(doc, {
  contentX,
  contentWidth,
  y,
  columns,
  tableX,
  tableWidth,
  rowHeight,
  headerHeight,
  chunk,
  exam,
  examId,
  subjects,
  getOverallGradeWithEnglishRule,
}) {
  const sectionHeight = headerHeight + rowHeight * Math.max(chunk.length, 1) + 14;
  drawCard(doc, contentX, y, contentWidth, sectionHeight);
  drawRowBackground(doc, tableX, y + 8, tableWidth, headerHeight, '#f4f7fc');

  let x = tableX;
  doc.fillColor('#5b6b80').font('Helvetica-Bold').fontSize(10);
  columns.forEach((column) => {
    doc.text(column.label, x + 4, y + 22, {
      width: column.width - 8,
      align: column.align,
    });
    x += column.width;
  });

  if (!chunk.length) {
    const rowY = y + 8 + headerHeight;
    drawRowBackground(doc, tableX, rowY, tableWidth, rowHeight, '#ffffff');
    doc.fillColor('#5b6b80').font('Helvetica').fontSize(9.5).text(
      'No student results available.',
      tableX + 8,
      rowY + 11,
      { width: tableWidth - 16, align: 'center' },
    );
    return;
  }

  chunk.forEach((entry, index) => {
    const rowY = y + 8 + headerHeight + rowHeight * index;
    let rowColor = index % 2 === 0 ? '#ffffff' : '#fafbfd';
    if (entry.rank === 1) rowColor = '#fff7e8';
    if (entry.rank === 2) rowColor = '#f7f8fb';
    if (entry.rank === 3) rowColor = '#fcf4ef';

    drawRowBackground(doc, tableX, rowY, tableWidth, rowHeight, rowColor);
    doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(tableX, rowY).lineTo(tableX + tableWidth, rowY).stroke();

    const studentResults = calculateStudentResults(examId, entry.student.id).results;
    const resultMap = new Map(studentResults.map((row) => [row.subject_id, row.score]));
    const overallGrade = getOverallGradeWithEnglishRule(exam, entry.averageScore, studentResults);
    const totalPoints = entry.totalPoints ?? studentResults.reduce((sum, row) => {
      const info = getGrade(Number(row.score), 'msce');
      return sum + (info.points || 0);
    }, 0);

    const values = [
      formatRank(entry.rank),
      entry.student.name,
      ...subjects.map((subject) => {
        const score = resultMap.get(subject.id);
        return score !== undefined ? formatWholeNumber(score) : '-';
      }),
      Number.isFinite(Number(entry.totalScore)) ? formatWholeNumber(entry.totalScore) : '-',
      Number.isFinite(entry.averageScore) ? formatWholeNumber(entry.averageScore) : '-',
      exam.grading_system === 'msce' ? formatPoints(totalPoints) : String(overallGrade.grade),
    ];

    x = tableX;
    values.forEach((value, colIndex) => {
      const isFinalCol = colIndex === values.length - 1;
      const textColor = exam.grading_system === 'msce' && isFinalCol ? '#d97706' : '#0f172a';
      const font = colIndex === 0 || colIndex === 1 || colIndex >= values.length - 3 ? 'Helvetica-Bold' : 'Helvetica';

      doc.fillColor(textColor).font(font).fontSize(9.5).text(String(value), x + 4, rowY + 11, {
        width: columns[colIndex].width - 8,
        align: columns[colIndex].align,
      });
      x += columns[colIndex].width;
    });
  });
}

export function renderPaginatedClassResultsPdf(doc, {
  schoolInfo,
  exam,
  subjects,
  rankings,
  logoPath,
  examId,
  getOverallGradeWithEnglishRule,
  margin = 20,
}) {
  const pageWidth = doc.page.width;
  const contentX = margin;
  const contentWidth = pageWidth - margin * 2;
  const rowHeight = 34;
  const headerHeight = 36;
  const columns = buildColumns(subjects, exam, contentWidth);
  const tableX = contentX;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

  if (!rankings.length) {
    const tableY = drawFullPageHeader(doc, { contentX, contentWidth, schoolInfo, exam, logoPath, margin });
    drawTableSection(doc, {
      contentX,
      contentWidth,
      y: tableY,
      columns,
      tableX,
      tableWidth,
      rowHeight,
      headerHeight,
      chunk: [],
      exam,
      examId,
      subjects,
      getOverallGradeWithEnglishRule,
    });
    return;
  }

  let rankingIndex = 0;
  let pageIndex = 0;

  while (rankingIndex < rankings.length) {
    if (pageIndex > 0) {
      doc.addPage();
    }

    const tableY = pageIndex === 0
      ? drawFullPageHeader(doc, { contentX, contentWidth, schoolInfo, exam, logoPath, margin })
      : drawContinuationHeader(doc, { contentX, contentWidth, schoolInfo, exam, margin });

    const maxRows = countRowsForPage(doc, tableY, rowHeight, headerHeight, margin);
    const chunk = rankings.slice(rankingIndex, rankingIndex + maxRows);

    drawTableSection(doc, {
      contentX,
      contentWidth,
      y: tableY,
      columns,
      tableX,
      tableWidth,
      rowHeight,
      headerHeight,
      chunk,
      exam,
      examId,
      subjects,
      getOverallGradeWithEnglishRule,
    });

    rankingIndex += chunk.length;
    pageIndex += 1;
  }
}
