import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess } from '../middleware/auth.js';
import { parseFile, parseMarksExcel } from '../utils/fileParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for file uploads
const uploadDir = process.env.OASIS_UPLOADS_DIR
  ? path.resolve(process.env.OASIS_UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  const allowedExtensions = ['.xlsx', '.xls', '.csv', '.pdf', '.doc', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only Excel, CSV, PDF, and Word files are allowed.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

router.use(authenticateToken);

function getDefaultSubjectIdsForNewStudent(classId) {
  const classRoom = db.prepare('SELECT min_subjects, max_subjects FROM classes WHERE id = ?').get(classId);
  if (!classRoom) {
    return { valid: false, error: 'Class not found' };
  }
  const subjectIds = db.prepare(`
    SELECT id
    FROM subjects
    WHERE class_id = ? AND is_compulsory = 1
  `).all(classId).map((row) => row.id);
  const minSubjects = Number(classRoom.min_subjects ?? 6);
  const maxSubjects = Number(classRoom.max_subjects ?? 12);
  if (subjectIds.length < minSubjects || subjectIds.length > maxSubjects) {
    return {
      valid: false,
      error: `Cannot add students: compulsory subjects (${subjectIds.length}) do not satisfy class limits (${minSubjects}-${maxSubjects})`
    };
  }
  return { valid: true, subjectIds };
}

// Parse uploaded file and return extracted data (preview)
router.post('/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;

    try {
      const result = await parseFile(filePath, req.file.mimetype);
      
      // Clean up file after parsing
      fs.unlinkSync(filePath);

      res.json({
        message: 'File parsed successfully',
        filename: req.file.originalname,
        students: result.students || [],
        headers: result.headers || [],
        rowCount: result.students?.length || 0
      });
    } catch (parseError) {
      // Clean up file on error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw parseError;
    }
  } catch (error) {
    next(error);
  }
});

// Import students from uploaded file
router.post('/students', upload.single('file'), async (req, res, next) => {
  try {
    const { class_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!class_id) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Class ID is required' });
    }

    // Verify class exists
    const classExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(class_id);
    if (!classExists) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Class not found' });
    }
    if (!ensureClassAccess(req, res, class_id)) {
      fs.unlinkSync(req.file.path);
      return;
    }

    const filePath = req.file.path;

    try {
      const result = await parseFile(filePath, req.file.mimetype);
      
      // Clean up file after parsing
      fs.unlinkSync(filePath);

      if (!result.students || result.students.length === 0) {
        return res.status(400).json({ error: 'No valid student data found in file' });
      }

      // Get existing student names in this class
      const existingNames = new Set(
        db.prepare('SELECT LOWER(name) as name FROM students WHERE class_id = ?')
          .all(class_id)
          .map(s => s.name)
      );

      const insert = db.prepare(`
        INSERT INTO students (id, class_id, name, gender, date_of_birth, guardian_name, guardian_phone, admission_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEnrollment = db.prepare('INSERT OR IGNORE INTO student_subjects (student_id, subject_id) VALUES (?, ?)');
      const defaultSubjects = getDefaultSubjectIdsForNewStudent(class_id);
      if (!defaultSubjects.valid) {
        return res.status(400).json({ error: defaultSubjects.error });
      }

      const insertMany = db.transaction((students) => {
        const created = [];
        const skipped = [];

        for (const s of students) {
          if (!s.name || typeof s.name !== 'string' || s.name.trim().length < 2) {
            skipped.push({ ...s, reason: 'Invalid name' });
            continue;
          }

          const normalizedName = s.name.trim().toLowerCase();
          if (existingNames.has(normalizedName)) {
            skipped.push({ ...s, reason: 'Duplicate name' });
            continue;
          }

          const id = uuidv4();
          const gender = s.gender === 'Female' ? 'Female' : 'Male';

          insert.run(
            id,
            class_id,
            s.name.trim(),
            gender,
            s.date_of_birth || null,
            s.guardian_name || null,
            s.guardian_phone || null,
            s.admission_number || null
          );
          defaultSubjects.subjectIds.forEach((subjectId) => insertEnrollment.run(id, subjectId));

          existingNames.add(normalizedName);
          created.push({ id, name: s.name });
        }

        return { created, skipped };
      });

      const importResult = insertMany(result.students);

      res.json({
        message: `Imported ${importResult.created.length} students`,
        imported: importResult.created.length,
        skipped: importResult.skipped.length,
        skippedDetails: importResult.skipped
      });
    } catch (parseError) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw parseError;
    }
  } catch (error) {
    next(error);
  }
});

// Preview marks from uploaded Excel file
router.post('/marks/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;

    try {
      const result = await parseMarksExcel(filePath);
      
      fs.unlinkSync(filePath);

      res.json({
        message: 'File parsed successfully',
        filename: req.file.originalname,
        subjects: result.headers || [],
        results: result.results || [],
        rowCount: result.results?.length || 0
      });
    } catch (parseError) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw parseError;
    }
  } catch (error) {
    next(error);
  }
});

// Import marks from uploaded Excel file
router.post('/marks', upload.single('file'), async (req, res, next) => {
  try {
    const { exam_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!exam_id) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Exam ID is required' });
    }

    const exam = db.prepare(`
      SELECT e.*, c.id as class_id 
      FROM exams e 
      JOIN classes c ON e.class_id = c.id 
      WHERE e.id = ?
    `).get(exam_id);

    if (!exam) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Exam not found' });
    }
    if (!ensureClassAccess(req, res, exam.class_id)) {
      fs.unlinkSync(req.file.path);
      return;
    }

    const filePath = req.file.path;

    try {
      const result = await parseMarksExcel(filePath);
      
      fs.unlinkSync(filePath);

      if (!result.results || result.results.length === 0) {
        return res.status(400).json({ error: 'No valid marks data found in file' });
      }

      // Get students and subjects for this class
      const students = db.prepare('SELECT id, name FROM students WHERE class_id = ?').all(exam.class_id);
      const subjects = db.prepare('SELECT id, name, code FROM subjects WHERE class_id = ?').all(exam.class_id);
      const enrollmentRows = db.prepare(`
        SELECT student_id, subject_id
        FROM student_subjects
        WHERE student_id IN (
          SELECT id FROM students WHERE class_id = ?
        )
      `).all(exam.class_id);
      const enrollmentSet = new Set(enrollmentRows.map((row) => `${row.student_id}:${row.subject_id}`));

      // Create lookup maps (case-insensitive)
      const studentMap = new Map(students.map(s => [s.name.toLowerCase(), s.id]));
      const subjectMap = new Map([
        ...subjects.map(s => [s.name.toLowerCase(), s.id]),
        ...subjects.map(s => [s.code.toLowerCase(), s.id])
      ]);

      // Import grades helper
      const { getGrade } = await import('../utils/grading.js');

      const upsert = db.prepare(`
        INSERT INTO exam_results (exam_id, student_id, subject_id, score, grade, points)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(exam_id, student_id, subject_id) 
        DO UPDATE SET score = ?, grade = ?, points = ?, updated_at = CURRENT_TIMESTAMP
      `);

      const importMarks = db.transaction((results) => {
        let saved = 0;
        const errors = [];

        for (const r of results) {
          const studentId = studentMap.get(r.studentName.toLowerCase());
          const subjectId = subjectMap.get(r.subjectName.toLowerCase());

          if (!studentId) {
            errors.push({ ...r, reason: 'Student not found' });
            continue;
          }

          if (!subjectId) {
            errors.push({ ...r, reason: 'Subject not found' });
            continue;
          }
          if (!enrollmentSet.has(`${studentId}:${subjectId}`)) {
            errors.push({ ...r, reason: 'Student is not assigned to this subject' });
            continue;
          }

          const score = parseFloat(r.score);
          const examMaxScore = Number(exam.max_score || 100);
          if (isNaN(score) || score < 0 || score > examMaxScore) {
            errors.push({ ...r, reason: `Invalid score (allowed range: 0-${examMaxScore})` });
            continue;
          }

          const roundedScore = Math.round(score);
          const { grade, points } = getGrade(roundedScore, exam.grading_system);
          upsert.run(exam_id, studentId, subjectId, roundedScore, grade, points, roundedScore, grade, points);
          saved++;
        }

        return { saved, errors };
      });

      const importResult = importMarks(result.results);

      res.json({
        message: `Imported ${importResult.saved} marks`,
        saved: importResult.saved,
        errors: importResult.errors.length,
        errorDetails: importResult.errors
      });
    } catch (parseError) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw parseError;
    }
  } catch (error) {
    next(error);
  }
});

export default router;
