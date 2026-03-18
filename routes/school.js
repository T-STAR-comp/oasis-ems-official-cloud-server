import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../db/database.js';
import { authenticateToken, getAssignedClassIds, isAdminUser, requireRole } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for logo uploads
const uploadsRoot = process.env.OASIS_UPLOADS_DIR
  ? path.resolve(process.env.OASIS_UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');
const logoDir = path.join(uploadsRoot, 'logos');
if (!fs.existsSync(logoDir)) {
  fs.mkdirSync(logoDir, { recursive: true });
}

function resolveStoredLogoPath(storedPath) {
  const cleanPath = String(storedPath || '').replace(/^\/+/, '');
  if (!cleanPath) return null;
  if (cleanPath.startsWith('uploads/')) {
    return path.join(uploadsRoot, cleanPath.slice('uploads/'.length));
  }
  return path.join(__dirname, '..', cleanPath);
}

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, logoDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'school-logo' + ext);
  }
});

const logoFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'), false);
  }
};

const uploadLogo = multer({
  storage: logoStorage,
  fileFilter: logoFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// Get school info (public - for reports)
router.get('/info', (req, res) => {
  const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
  res.json({ school: schoolInfo });
});

// Update school info
router.put('/info', authenticateToken, requireRole('admin', 'secretary'), (req, res, next) => {
  try {
    const { name, address, phone, email, motto, opening_date, school_fees, headteacher_name, headteacher_signature } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ error: 'School name cannot be empty' });
      }
      updates.push('name = ?');
      values.push(name.trim());
    }
    if (address !== undefined) {
      updates.push('address = ?');
      values.push(address);
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      values.push(phone);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email);
    }
    if (motto !== undefined) {
      updates.push('motto = ?');
      values.push(motto);
    }
    if (opening_date !== undefined) {
      updates.push('opening_date = ?');
      values.push(opening_date);
    }
    if (school_fees !== undefined) {
      updates.push('school_fees = ?');
      values.push(school_fees);
    }
    if (headteacher_name !== undefined) {
      updates.push('headteacher_name = ?');
      values.push(headteacher_name);
    }
    if (headteacher_signature !== undefined) {
      updates.push('headteacher_signature = ?');
      values.push(headteacher_signature);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE school_info SET ${updates.join(', ')} WHERE id = 1`).run(...values);
    }

    const schoolInfo = db.prepare('SELECT * FROM school_info WHERE id = 1').get();
    res.json({ message: 'School info updated', school: schoolInfo });
  } catch (error) {
    next(error);
  }
});

// Upload school logo
router.post('/logo', authenticateToken, requireRole('admin', 'secretary'), uploadLogo.single('logo'), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Delete old logo if it exists and is different
    const currentInfo = db.prepare('SELECT logo FROM school_info WHERE id = 1').get();
    if (currentInfo.logo) {
      const oldLogoPath = resolveStoredLogoPath(currentInfo.logo);
      if (oldLogoPath && fs.existsSync(oldLogoPath) && oldLogoPath !== req.file.path) {
        try {
          fs.unlinkSync(oldLogoPath);
        } catch (e) {
          // Ignore deletion errors
        }
      }
    }

    const logoPath = '/uploads/logos/' + req.file.filename;
    
    db.prepare('UPDATE school_info SET logo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
      .run(logoPath);

    res.json({ 
      message: 'Logo uploaded successfully',
      logo: logoPath
    });
  } catch (error) {
    next(error);
  }
});

// Delete school logo
router.delete('/logo', authenticateToken, requireRole('admin'), (req, res, next) => {
  try {
    const currentInfo = db.prepare('SELECT logo FROM school_info WHERE id = 1').get();
    
    if (currentInfo.logo) {
      const logoPath = resolveStoredLogoPath(currentInfo.logo);
      if (logoPath && fs.existsSync(logoPath)) {
        fs.unlinkSync(logoPath);
      }
    }

    db.prepare('UPDATE school_info SET logo = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run();

    res.json({ message: 'Logo deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// Get dashboard statistics
router.get('/stats', authenticateToken, (req, res) => {
  let allowedClassIds = null;
  if (!isAdminUser(req.user)) {
    allowedClassIds = getAssignedClassIds(req.user.id);
    if (allowedClassIds.length === 0) {
      return res.json({
        stats: { totalClasses: 0, totalStudents: 0, totalExams: 0 },
        recentExams: [],
        classSummary: []
      });
    }
  }

  const classFilter = allowedClassIds
    ? `WHERE c.id IN (${allowedClassIds.map(() => '?').join(',')})`
    : '';
  const examFilter = allowedClassIds
    ? `WHERE e.class_id IN (${allowedClassIds.map(() => '?').join(',')})`
    : '';
  const studentFilter = allowedClassIds
    ? `WHERE s.class_id IN (${allowedClassIds.map(() => '?').join(',')})`
    : '';
  const params = allowedClassIds || [];

  const totalClasses = db.prepare(`SELECT COUNT(*) as count FROM classes c ${classFilter}`).get(...params).count;
  const totalStudents = db.prepare(`SELECT COUNT(*) as count FROM students s ${studentFilter}`).get(...params).count;
  const totalExams = db.prepare(`SELECT COUNT(*) as count FROM exams e ${examFilter}`).get(...params).count;
  
  const recentExams = db.prepare(`
    SELECT e.*, c.name as class_name
    FROM exams e
    JOIN classes c ON e.class_id = c.id
    ${examFilter}
    ORDER BY e.created_at DESC
    LIMIT 5
  `).all(...params);

  const classSummary = db.prepare(`
    SELECT c.id, c.name, c.year,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) as student_count,
      (SELECT COUNT(*) FROM exams e WHERE e.class_id = c.id) as exam_count
    FROM classes c
    ${classFilter}
    ORDER BY c.year DESC, c.name ASC
    LIMIT 10
  `).all(...params);

  res.json({
    stats: {
      totalClasses,
      totalStudents,
      totalExams
    },
    recentExams,
    classSummary
  });
});

// Get grading criteria
router.get('/grading', authenticateToken, (req, res) => {
  const system = req.query.system || 'normal';

  if (!['normal', 'msce'].includes(system)) {
    return res.status(400).json({ error: 'Invalid grading system' });
  }

  const criteria = db.prepare(`
    SELECT grade, min_score, max_score, points, remark
    FROM grade_criteria
    WHERE system = ?
    ORDER BY min_score DESC
  `).all(system);

  res.json({ criteria });
});

// Update grading criteria
router.put('/grading', authenticateToken, requireRole('admin', 'secretary'), (req, res, next) => {
  try {
    const { criteria, system = 'normal' } = req.body;

    if (!['normal', 'msce'].includes(system)) {
      return res.status(400).json({ error: 'Invalid grading system' });
    }

    if (!Array.isArray(criteria) || criteria.length === 0) {
      return res.status(400).json({ error: 'Criteria array required' });
    }

    const clearSystem = db.prepare('DELETE FROM grade_criteria WHERE system = ?');
    const insert = db.prepare(`
      INSERT INTO grade_criteria (grade, min_score, max_score, points, remark, system)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const saveCriteria = db.transaction((items, gradingSystem) => {
      clearSystem.run(gradingSystem);

      for (const item of items) {
        const minScore = Number(item.min_score);
        const maxScore = Number(item.max_score);
        const points = item.points !== undefined && item.points !== null ? Number(item.points) : null;

        if (Number.isNaN(minScore) || Number.isNaN(maxScore)) {
          throw new Error('Invalid score range in criteria');
        }

        const grade = item.grade ?? (gradingSystem === 'msce' ? String(points ?? '') : '');
        const remark = item.remark ?? '';

        insert.run(grade, minScore, maxScore, points, remark, gradingSystem);
      }
    });

    saveCriteria(criteria, system);

    const updated = db.prepare(`
      SELECT grade, min_score, max_score, points, remark
      FROM grade_criteria
      WHERE system = ?
      ORDER BY min_score DESC
    `).all(system);

    res.json({ message: 'Grading criteria updated successfully', criteria: updated });
  } catch (error) {
    next(error);
  }
});

export default router;
