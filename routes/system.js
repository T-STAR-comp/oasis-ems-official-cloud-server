import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, {
  getContextSchoolId,
  initializeDatabase,
  isFreshBootstrapState,
  registerTenantSchool,
  resolveSchoolIdFromImportPayload,
  runWithSchoolContext,
} from '../db/database.js';
import { authenticateToken, isAdminUser } from '../middleware/auth.js';
import { persistSchoolLogoFile, resolveUploadsRoot } from '../utils/schoolLogo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = resolveUploadsRoot(__dirname);

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
  'exam_merge_sources',
  'promotion_criteria',
  'promotion_actions',
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

function hasValidMigrationGrant(bootstrap) {
  const tenantSchoolId = getContextSchoolId();
  const internalUid = String(bootstrap?.internal_uid || '').trim();
  const chargeId = String(bootstrap?.charge_id || '').trim();
  const activationCode = String(bootstrap?.activation_code || '').trim();
  if (!tenantSchoolId || (!internalUid && !chargeId && !activationCode)) {
    return false;
  }

  const row = db.prepare(`
    SELECT id, status
    FROM subscription_records
    WHERE school_id = ?
      AND online_features_enabled = 1
      AND status IN ('active', 'pending_activation')
      AND (
        (? != '' AND internal_uid = ?)
        OR (? != '' AND charge_id = ?)
        OR (? != '' AND activation_code = ?)
      )
    ORDER BY
      CASE status WHEN 'active' THEN 0 ELSE 1 END,
      COALESCE(expires_at, created_at) DESC
    LIMIT 1
  `).get(
    tenantSchoolId,
    internalUid,
    internalUid,
    chargeId,
    chargeId,
    activationCode,
    activationCode
  );

  return Boolean(row);
}

function finalizeImport(schoolId, data, bootstrap = {}) {
  applyImportPayload(data);
  const logoAsset = bootstrap?.assets?.logo;
  if (logoAsset?.base64) {
    try {
      const ext = String(logoAsset.ext || '.png');
      const stored = persistSchoolLogoFile(
        schoolId,
        Buffer.from(String(logoAsset.base64), 'base64'),
        ext,
        uploadsRoot,
      );
      db.prepare('UPDATE school_info SET logo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
        .run(stored.storedPath);
    } catch (error) {
      console.error('[oasis-cloud] migration.logo_persist_failed', {
        school_id: schoolId,
        message: error?.message || 'unknown',
      });
    }
  }

  const schoolName = Array.isArray(data?.school_info) ? data.school_info[0]?.name : undefined;
  registerTenantSchool(schoolId, {
    name: schoolName || schoolId,
    source: 'migration',
  });
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
  const { data, bootstrap } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid migration payload' });
  }

  const schoolId = resolveSchoolIdFromImportPayload(data);
  if (!schoolId) {
    return res.status(400).json({ error: 'School ID is missing from the migration payload.' });
  }

  const payload = { data, bootstrap: bootstrap || {} };

  return runWithSchoolContext(schoolId, () => {
    initializeDatabase(schoolId);

    if (hasValidMigrationGrant(payload.bootstrap)) {
      finalizeImport(schoolId, data, payload.bootstrap);
      return res.json({
        message: isFreshBootstrapState() ? 'Bootstrap import completed' : 'Migration import completed',
        school_id: schoolId,
      });
    }

    if (!isFreshBootstrapState()) {
      return authenticateToken(req, res, () => {
        if (!ensureAdmin(req, res)) return;
        finalizeImport(schoolId, data, payload.bootstrap);
        return res.json({ message: 'Migration import completed', school_id: schoolId });
      });
    }

    return res.status(403).json({
      error: 'Cloud migration requires a verified online subscription for this School ID. Finish payment verification and activation, then try again.',
    });
  }, { allowCreate: true });
});

export default router;
