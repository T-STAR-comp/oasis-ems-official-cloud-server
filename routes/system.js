import express from 'express';
import db from '../db/database.js';
import { authenticateToken, isAdminUser } from '../middleware/auth.js';

const router = express.Router();

const TABLES = [
  'users',
  'school_info',
  'classes',
  'students',
  'subjects',
  'student_subjects',
  'exams',
  'exam_results',
  'grade_criteria',
  'user_class_assignments',
  'exam_subject_grading_profiles',
  'app_identity',
];

function ensureAdmin(req, res) {
  if (!req.user || !isAdminUser(req.user)) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

function exportTables() {
  const payload = {};
  TABLES.forEach((table) => {
    payload[table] = db.prepare(`SELECT * FROM ${table}`).all();
  });
  return payload;
}

function applyImportPayload(payload) {
  const tx = db.transaction((data) => {
    db.exec('PRAGMA foreign_keys = OFF;');
    TABLES.slice().reverse().forEach((table) => {
      db.prepare(`DELETE FROM ${table}`).run();
    });

    TABLES.forEach((table) => {
      const rows = Array.isArray(data?.[table]) ? data[table] : [];
      if (!rows.length) return;
      const tableColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const insertColumns = rows.length > 0
        ? Object.keys(rows[0]).filter((column) => tableColumns.includes(column))
        : [];
      if (!insertColumns.length) return;
      const placeholders = insertColumns.map(() => '?').join(', ');
      const stmt = db.prepare(`
        INSERT INTO ${table} (${insertColumns.join(', ')})
        VALUES (${placeholders})
      `);
      rows.forEach((row) => {
        stmt.run(...insertColumns.map((column) => row[column]));
      });
    });
    db.exec('PRAGMA foreign_keys = ON;');
  });
  tx(payload || {});
}

router.get('/export', authenticateToken, (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const data = exportTables();
  res.json({
    exported_at: new Date().toISOString(),
    schema_version: '1.0',
    data,
  });
});

router.post('/import-bootstrap', (req, res) => {
  const existingUsers = Number(db.prepare('SELECT COUNT(*) as count FROM users').get()?.count || 0);
  if (existingUsers > 0) {
    return authenticateToken(req, res, () => {
      if (!ensureAdmin(req, res)) return;
      const { data } = req.body || {};
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Invalid migration payload' });
      }
      applyImportPayload(data);
      return res.json({ message: 'Migration import completed' });
    });
  }
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid migration payload' });
  }
  applyImportPayload(data);
  return res.json({ message: 'Bootstrap import completed' });
});

export default router;
