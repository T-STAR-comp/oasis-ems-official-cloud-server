import PDFDocument from 'pdfkit';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { renderStudentReportCardPage } from './reportCardPdf.js';

function pdfBufferFromReport(renderFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 24, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    renderFn(doc);
    doc.end();
  });
}

function sanitizeFilename(value) {
  return String(value || 'student').replace(/[^\w.-]+/g, '_').slice(0, 80);
}

export async function buildStudentReportsZip({ rankings, exam, schoolInfo, formTeacherName, logoPath, criteria, subjectTeacherMap, buildReportContext }) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const passThrough = new PassThrough();
  archive.pipe(passThrough);

  const buffers = [];
  passThrough.on('data', (chunk) => buffers.push(chunk));

  const zipPromise = new Promise((resolve, reject) => {
    passThrough.on('end', () => resolve(Buffer.concat(buffers)));
    passThrough.on('error', reject);
    archive.on('error', reject);
  });

  for (const entry of rankings) {
    const ctx = buildReportContext(entry);
    const pdfBuffer = await pdfBufferFromReport((doc) => {
      renderStudentReportCardPage({
        doc,
        schoolInfo,
        student: entry.student,
        exam,
        rankingsCount: rankings.length,
        studentRank: ctx.studentRank,
        totalPoints: ctx.totalPoints,
        formTeacherName,
        logoPath,
        criteria,
        results: ctx.results,
        totalScore: ctx.totalScore,
        overallGrade: ctx.overallGrade,
        passFail: ctx.passFail,
        subjectTeacherMap,
        subjectRankMaps: ctx.subjectRankMaps,
        studentId: entry.student.id,
      });
    });

    const filename = `${sanitizeFilename(entry.student.name)}_${sanitizeFilename(entry.student.admission_number || entry.student.id)}.pdf`;
    archive.append(pdfBuffer, { name: filename });
  }

  await archive.finalize();
  return zipPromise;
}
