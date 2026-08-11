import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  MysqlCompatConnection,
  ensureMysqlDatabase,
  ensureMysqlSharedDatabase,
  isMysqlEnabled,
  resolveMysqlConnectionTarget,
  resolveMysqlDatabaseName,
  resolveMysqlTenantMode,
} from './mysqlAdapter.js';
import {
  DEFAULT_COUNTRY,
  normalizeCountry,
  ALL_GRADING_SYSTEMS,
  getDefaultCriteriaForSystem,
  getGradingSystemsForCountry,
} from '../utils/education.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyIfExists(sourcePath, destinationPath) {
  if (fs.existsSync(sourcePath) && !fs.existsSync(destinationPath)) {
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function normalizeSchoolId(value) {
  return String(value || '').trim().toUpperCase();
}

function createTenantError(message, statusCode = 400) {
  const error = new Error(message);
  error.status = statusCode;
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function resolveDataRoot() {
  const preferredDir = process.env.OASIS_DATA_DIR
    ? path.resolve(process.env.OASIS_DATA_DIR)
    : __dirname;
  ensureDirectory(preferredDir);
  ensureDirectory(path.join(preferredDir, 'schools'));
  return preferredDir;
}

function resolveLegacyDatabasePath() {
  return path.join(__dirname, 'school.db');
}

function sanitizeSchoolIdForPath(schoolId) {
  const normalized = normalizeSchoolId(schoolId);
  return normalized.replace(/[^A-Z0-9-]/g, '_');
}

function resolveTenantDatabasePath(schoolId) {
  const tenantDir = path.join(resolveDataRoot(), 'schools', sanitizeSchoolIdForPath(schoolId));
  ensureDirectory(tenantDir);
  return path.join(tenantDir, 'school.db');
}

const tenantContext = new AsyncLocalStorage();
const tenantConnections = new Map();
const initializedTenants = new Set();
const initializingTenants = new Set();
const USE_MYSQL = isMysqlEnabled();
console.log('[oasis-cloud] startup.database_mode', {
  mode: USE_MYSQL ? 'mysql' : 'sqlite',
  data_dir: process.env.OASIS_DATA_DIR || null,
  mysql_tenant_mode: USE_MYSQL ? resolveMysqlTenantMode() : null,
  mysql_database: USE_MYSQL && resolveMysqlTenantMode() === 'shared'
    ? (process.env.MYSQL_DATABASE || null)
    : null,
});

function resolveTenantRegistryPath() {
  return path.join(resolveDataRoot(), 'tenant-registry.json');
}

function readTenantRegistry() {
  const registryPath = resolveTenantRegistryPath();
  try {
    if (fs.existsSync(registryPath)) {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (Array.isArray(parsed?.schools)) {
        return parsed;
      }
    }
  } catch (_error) {
    // Fall back to an empty registry.
  }
  return { schools: [], updated_at: null };
}

function writeTenantRegistry(registry) {
  const registryPath = resolveTenantRegistryPath();
  const payload = {
    ...registry,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function listSqliteTenantIds() {
  const schoolsRoot = path.join(resolveDataRoot(), 'schools');
  if (!fs.existsSync(schoolsRoot)) {
    return [];
  }
  return fs.readdirSync(schoolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(schoolsRoot, entry.name, 'school.db')))
    .map((entry) => entry.name);
}

export function listRegisteredTenants() {
  const registry = readTenantRegistry();
  const knownIds = new Set(registry.schools.map((entry) => normalizeSchoolId(entry.school_id)));

  if (!USE_MYSQL) {
    listSqliteTenantIds().forEach((dirName) => {
      const schoolId = normalizeSchoolId(dirName);
      if (!knownIds.has(schoolId)) {
        registry.schools.push({
          school_id: schoolId,
          storage: 'sqlite',
          database: resolveTenantDatabasePath(schoolId),
          source: 'discovered',
        });
        knownIds.add(schoolId);
      }
    });
  }

  return registry.schools
    .map((entry) => ({
      ...entry,
      school_id: normalizeSchoolId(entry.school_id),
    }))
    .sort((left, right) => String(left.school_id).localeCompare(String(right.school_id)));
}

export function registerTenantSchool(schoolId, meta = {}) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (!normalizedSchoolId) {
    return null;
  }

  const registry = readTenantRegistry();
  const mysqlTarget = USE_MYSQL ? resolveMysqlConnectionTarget(normalizedSchoolId) : null;
  const storageTarget = USE_MYSQL
    ? (mysqlTarget.tablePrefix ? `${mysqlTarget.database}#${mysqlTarget.tablePrefix}` : mysqlTarget.database)
    : resolveTenantDatabasePath(normalizedSchoolId);
  const nextEntry = {
    school_id: normalizedSchoolId,
    name: meta.name || normalizedSchoolId,
    storage: USE_MYSQL ? 'mysql' : 'sqlite',
    database: storageTarget,
    updated_at: new Date().toISOString(),
    ...meta,
  };

  const existingIndex = registry.schools.findIndex(
    (entry) => normalizeSchoolId(entry.school_id) === normalizedSchoolId,
  );
  if (existingIndex >= 0) {
    registry.schools[existingIndex] = {
      ...registry.schools[existingIndex],
      ...nextEntry,
    };
  } else {
    registry.schools.push(nextEntry);
  }

  writeTenantRegistry(registry);
  console.log('[oasis-cloud] tenant.registered', {
    school_id: normalizedSchoolId,
    storage: nextEntry.storage,
    database: nextEntry.database,
    source: meta.source || 'unknown',
  });
  return nextEntry;
}

function getContextStore() {
  return tenantContext.getStore() || null;
}

export function getContextSchoolId() {
  return normalizeSchoolId(getContextStore()?.schoolId);
}

function readSchoolIdFromToken(req) {
  const authHeader = String(req?.headers?.authorization || '');
  if (!authHeader.startsWith('Bearer ')) return '';
  try {
    const decoded = jwt.decode(authHeader.slice('Bearer '.length));
    return normalizeSchoolId(decoded?.school_id);
  } catch (_error) {
    return '';
  }
}

function inferSchoolIdFromImportPayload(payload) {
  const row = Array.isArray(payload?.school_info) ? payload.school_info[0] : null;
  return normalizeSchoolId(row?.school_id);
}

function readSchoolIdFromHeader(req) {
  return normalizeSchoolId(
    req?.headers?.['x-school-id'] ||
    req?.headers?.['X-School-Id']
  );
}

function resolveRequestSchoolId(req) {
  return (
    readSchoolIdFromToken(req) ||
    readSchoolIdFromHeader(req) ||
    normalizeSchoolId(req?.body?.school_id) ||
    inferSchoolIdFromImportPayload(req?.body?.data) ||
    normalizeSchoolId(req?.query?.school_id)
  );
}

function createConnection(schoolId) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (USE_MYSQL) {
    const target = resolveMysqlConnectionTarget(normalizedSchoolId);
    if (target.mode === 'database') {
      ensureMysqlDatabase(target.database);
    } else {
      ensureMysqlSharedDatabase(target.database);
    }
    return new MysqlCompatConnection(target.database, { tablePrefix: target.tablePrefix });
  }

  const dbPath = resolveTenantDatabasePath(normalizedSchoolId);
  const connection = new Database(dbPath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  return connection;
}

function migrateLegacyDatabaseIfNeeded(schoolId, tenantDbPath) {
  const legacyDbPath = resolveLegacyDatabasePath();
  if (!fs.existsSync(legacyDbPath) || fs.existsSync(tenantDbPath)) {
    return;
  }

  try {
    const legacyDb = new Database(legacyDbPath, { readonly: true, fileMustExist: true });
    const row = legacyDb.prepare('SELECT school_id FROM school_info WHERE id = 1').get();
    legacyDb.close();
    if (normalizeSchoolId(row?.school_id) !== normalizeSchoolId(schoolId)) {
      return;
    }
    copyIfExists(legacyDbPath, tenantDbPath);
    copyIfExists(`${legacyDbPath}-wal`, `${tenantDbPath}-wal`);
    copyIfExists(`${legacyDbPath}-shm`, `${tenantDbPath}-shm`);
  } catch (_error) {
    // Ignore legacy migration failures and fall back to normal tenant provisioning.
  }
}

function ensureTenantInitialized(schoolId) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (!normalizedSchoolId || initializedTenants.has(normalizedSchoolId) || initializingTenants.has(normalizedSchoolId)) {
    return;
  }

  initializingTenants.add(normalizedSchoolId);
  try {
    runWithSchoolContext(normalizedSchoolId, () => {
      bootstrapCurrentDatabase();
    }, { allowCreate: true });
    initializedTenants.add(normalizedSchoolId);
    console.log('[oasis-cloud] tenant.bootstrap_ok', { school_id: normalizedSchoolId });
  } catch (error) {
    console.error('[oasis-cloud] tenant.bootstrap_failed', {
      school_id: normalizedSchoolId,
      message: error?.message || String(error),
    });
    throw error;
  } finally {
    initializingTenants.delete(normalizedSchoolId);
  }
}

function getTenantConnection(schoolId, { allowCreate = false } = {}) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (!normalizedSchoolId) {
    throw createTenantError('School ID is required for cloud access.', 400);
  }

  const mysqlTarget = USE_MYSQL ? resolveMysqlConnectionTarget(normalizedSchoolId) : null;
  const dbPath = USE_MYSQL
    ? mysqlTarget.database
    : resolveTenantDatabasePath(normalizedSchoolId);
  const logTarget = USE_MYSQL && mysqlTarget.tablePrefix
    ? `${mysqlTarget.database} (${mysqlTarget.tablePrefix}_*)`
    : dbPath;
  console.log('[oasis-cloud] tenant.connection_resolve', {
    school_id: normalizedSchoolId,
    storage: USE_MYSQL ? 'mysql' : 'sqlite',
    mysql_tenant_mode: mysqlTarget?.mode || null,
    target: logTarget,
    allow_create: allowCreate === true,
  });
  if (!USE_MYSQL && !fs.existsSync(dbPath)) {
    migrateLegacyDatabaseIfNeeded(normalizedSchoolId, dbPath);
  }
  if (!USE_MYSQL && !fs.existsSync(dbPath) && !allowCreate) {
    throw createTenantError('School was not found in cloud storage. Verify the School ID or migrate the school first.', 404);
  }

  let connection = tenantConnections.get(normalizedSchoolId);
  if (!connection) {
    connection = createConnection(normalizedSchoolId);
    tenantConnections.set(normalizedSchoolId, connection);
    console.log('[oasis-cloud] tenant.connection_created', {
      school_id: normalizedSchoolId,
      storage: USE_MYSQL ? 'mysql' : 'sqlite',
      target: logTarget,
    });
  }

  ensureTenantInitialized(normalizedSchoolId);
  return connection;
}

function getActiveConnection() {
  const store = getContextStore();
  const normalizedSchoolId = normalizeSchoolId(store?.schoolId);
  if (!normalizedSchoolId) {
    throw createTenantError('School context is required for this cloud request.', 400);
  }

  return getTenantConnection(normalizedSchoolId, {
    allowCreate: store?.allowCreate === true,
  });
}

const db = new Proxy({}, {
  get(_target, property) {
    const connection = getActiveConnection();
    const value = connection[property];
    return typeof value === 'function' ? value.bind(connection) : value;
  },
});

export function runWithSchoolContext(schoolId, fn, { allowCreate = false } = {}) {
  const normalizedSchoolId = normalizeSchoolId(schoolId);
  if (!normalizedSchoolId) {
    throw createTenantError('School ID is required for this cloud request.', 400);
  }

  return tenantContext.run({
    schoolId: normalizedSchoolId,
    allowCreate: allowCreate === true,
  }, fn);
}

export function bindSchoolContext(req, _res, next) {
  const schoolId = resolveRequestSchoolId(req);
  if (!schoolId) {
    return next();
  }

  return runWithSchoolContext(schoolId, () => next(), { allowCreate: false });
}

export function resolveSchoolIdFromImportPayload(payload) {
  return inferSchoolIdFromImportPayload(payload);
}
function resolveUidSecret() {
  const secret = String(process.env.OASIS_UID_SECRET || process.env.JWT_SECRET || '').trim();
  if (!secret) {
    throw new Error('Missing OASIS_UID_SECRET environment variable.');
  }
  return secret;
}

function uidSecretKey() {
  return crypto.createHash('sha256').update(resolveUidSecret()).digest();
}

function encryptUid(uid) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', uidSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(uid, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    encrypted.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

function decryptUid(payload) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported UID payload format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const encrypted = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', uidSecretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function ensureInternalUid() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      encrypted_uid TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const row = db.prepare('SELECT encrypted_uid FROM app_identity WHERE id = 1').get();
  if (!row) {
    const generatedUid = crypto.randomUUID();
    db.prepare(`
      INSERT INTO app_identity (id, encrypted_uid)
      VALUES (1, ?)
    `).run(encryptUid(generatedUid));
    return generatedUid;
  }

  try {
    return decryptUid(row.encrypted_uid);
  } catch (_error) {
    const regeneratedUid = crypto.randomUUID();
    db.prepare(`
      UPDATE app_identity
      SET encrypted_uid = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(encryptUid(regeneratedUid));
    return regeneratedUid;
  }
}

function generateSchoolId() {
  const segment = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `OASIS-${segment()}-${segment()}`;
}

function ensureSchoolIdentity() {
  const row = db.prepare('SELECT id, school_id, country FROM school_info WHERE id = 1').get();
  if (!row) {
    const newId = generateSchoolId();
    const country = DEFAULT_COUNTRY;
    db.prepare(`
      INSERT INTO school_info (
        id, name, address, phone, email, logo, motto, opening_date, school_fees,
        headteacher_name, headteacher_signature,
        academic_year_start_date, academic_year_end_date,
        semester1_start_date, semester1_end_date,
        semester2_start_date, semester2_end_date,
        country, school_id
      )
      VALUES (1, 'My School', '', '', '', NULL, '', '', '', '', '', '', '', '', '', '', '', ?, ?)
    `).run(country, newId);
    return { schoolId: newId, country };
  }

  let updated = false;
  let schoolId = row.school_id;
  let country = row.country;
  if (!schoolId) {
    schoolId = generateSchoolId();
    updated = true;
  }
  if (!country) {
    country = DEFAULT_COUNTRY;
    updated = true;
  }
  if (updated) {
    db.prepare(`
      UPDATE school_info
      SET school_id = ?, country = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(schoolId, country);
  }
  return { schoolId, country: normalizeCountry(country) };
}

export function isFreshBootstrapState() {
  const userCount = Number(db.prepare('SELECT COUNT(*) as count FROM users').get()?.count || 0);
  if (userCount > 0) return false;

  const operationalTables = [
    'students',
    'exams',
    'exam_results',
    'user_class_assignments',
  ];

  return !operationalTables.some((table) => {
    const count = Number(db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get()?.count || 0);
    return count > 0;
  });
}

function ensureTableHasGradingSystems(tableName, systems) {
  const sql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(tableName)?.sql;
  if (!sql) return true;
  return systems.every((system) => sql.includes(`'${system}'`));
}

function migrateExamTable() {
  if (ensureTableHasGradingSystems('exams', ALL_GRADING_SYSTEMS)) return;
  const columnInfo = db.prepare('PRAGMA table_info(exams)').all();
  if (columnInfo.length === 0) return;

  const columns = columnInfo.map((c) => c.name);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE exams RENAME TO exams_old;');
  db.exec(`
    CREATE TABLE exams (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('test', 'midterm', 'endterm')),
      term TEXT NOT NULL,
      year TEXT NOT NULL,
      grading_system TEXT NOT NULL DEFAULT 'normal' CHECK(grading_system IN (${ALL_GRADING_SYSTEMS.map((s) => `'${s}'`).join(', ')})),
      max_score REAL NOT NULL DEFAULT 100,
      component_exam_id TEXT,
      component_weight REAL NOT NULL DEFAULT 0,
      current_weight REAL NOT NULL DEFAULT 100,
      lock_status TEXT NOT NULL DEFAULT 'none',
      locked_at DATETIME,
      locked_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    )
  `);
  const newColumns = [
    'id',
    'class_id',
    'name',
    'type',
    'term',
    'year',
    'grading_system',
    'max_score',
    'component_exam_id',
    'component_weight',
    'current_weight',
    'lock_status',
    'locked_at',
    'locked_by',
    'created_at',
    'updated_at',
  ];
  const copyColumns = newColumns.filter((column) => columns.includes(column));
  if (copyColumns.length > 0) {
    db.exec(`
      INSERT INTO exams (${copyColumns.join(', ')})
      SELECT ${copyColumns.join(', ')} FROM exams_old
    `);
  }
  db.exec('DROP TABLE exams_old;');
  db.exec('PRAGMA foreign_keys = ON;');
}

function migrateGradeCriteriaTable() {
  if (ensureTableHasGradingSystems('grade_criteria', ALL_GRADING_SYSTEMS)) return;
  const columnInfo = db.prepare('PRAGMA table_info(grade_criteria)').all();
  if (columnInfo.length === 0) return;
  const columns = columnInfo.map((c) => c.name);

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE grade_criteria RENAME TO grade_criteria_old;');
  db.exec(`
    CREATE TABLE grade_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grade TEXT NOT NULL,
      min_score REAL NOT NULL,
      max_score REAL NOT NULL,
      points INTEGER,
      remark TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT 'normal' CHECK(system IN (${ALL_GRADING_SYSTEMS.map((s) => `'${s}'`).join(', ')}))
    )
  `);
  const newColumns = ['id', 'grade', 'min_score', 'max_score', 'points', 'remark', 'system'];
  const copyColumns = newColumns.filter((column) => columns.includes(column));
  if (copyColumns.length > 0) {
    db.exec(`
      INSERT INTO grade_criteria (${copyColumns.join(', ')})
      SELECT ${copyColumns.join(', ')} FROM grade_criteria_old
    `);
  }
  db.exec('DROP TABLE grade_criteria_old;');
  db.exec('PRAGMA foreign_keys = ON;');
}

function migrateExamSubjectProfilesTable() {
  if (ensureTableHasGradingSystems('exam_subject_grading_profiles', [...ALL_GRADING_SYSTEMS, 'custom'])) return;
  const columnInfo = db.prepare('PRAGMA table_info(exam_subject_grading_profiles)').all();
  if (columnInfo.length === 0) return;
  const columns = columnInfo.map((c) => c.name);

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE exam_subject_grading_profiles RENAME TO exam_subject_grading_profiles_old;');
  db.exec(`
    CREATE TABLE exam_subject_grading_profiles (
      exam_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      grading_system TEXT NOT NULL CHECK(grading_system IN (${[...ALL_GRADING_SYSTEMS, 'custom'].map((s) => `'${s}'`).join(', ')})),
      custom_criteria TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, subject_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    )
  `);
  const newColumns = ['exam_id', 'subject_id', 'grading_system', 'custom_criteria', 'updated_at'];
  const copyColumns = newColumns.filter((column) => columns.includes(column));
  if (copyColumns.length > 0) {
    db.exec(`
      INSERT INTO exam_subject_grading_profiles (${copyColumns.join(', ')})
      SELECT ${copyColumns.join(', ')} FROM exam_subject_grading_profiles_old
    `);
  }
  db.exec('DROP TABLE exam_subject_grading_profiles_old;');
  db.exec('PRAGMA foreign_keys = ON;');
}

function repairExamResultsForeignKey() {
  const tableInfo = db.prepare('PRAGMA table_info(exam_results)').all();
  if (tableInfo.length === 0) return;

  const fkRows = db.prepare('PRAGMA foreign_key_list(exam_results)').all();
  const examFk = fkRows.find((row) => row.from === 'exam_id');
  if (!examFk || examFk.table === 'exams') return;

  const legacyTable = 'exam_results_old_fkfix';
  const allColumns = [
    'id',
    'exam_id',
    'student_id',
    'subject_id',
    'score',
    'grade',
    'points',
    'created_at',
    'updated_at',
  ];
  const existingColumns = tableInfo.map((column) => column.name);
  const copyColumns = allColumns.filter((column) => existingColumns.includes(column));

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    const legacyExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(legacyTable);
    if (legacyExists) {
      db.exec(`DROP TABLE ${legacyTable}`);
    }

    db.exec(`ALTER TABLE exam_results RENAME TO ${legacyTable}`);
    db.exec(`
      CREATE TABLE exam_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
        grade TEXT,
        points INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
        UNIQUE(exam_id, student_id, subject_id)
      )
    `);

    if (copyColumns.length > 0) {
      db.exec(`
        INSERT INTO exam_results (${copyColumns.join(', ')})
        SELECT ${copyColumns.join(', ')} FROM ${legacyTable}
      `);
    }

    db.exec(`DROP TABLE ${legacyTable}`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateGradingTables() {
  try {
    migrateExamTable();
    migrateGradeCriteriaTable();
    migrateExamSubjectProfilesTable();
    repairExamResultsForeignKey();
    console.log('[oasis-cloud] database.migrations.grading_tables_ok');
  } catch (error) {
    console.error('[oasis-cloud] database.migrations.grading_tables_failed', error);
    throw error;
  }
}

function seedDefaultConductCategories() {
  const count = Number(db.prepare('SELECT COUNT(*) as count FROM conduct_categories').get()?.count || 0);
  if (count > 0) return;

  const defaults = [
    { id: 'pos-helpfulness', name: 'Helpfulness', type: 'positive', points: 2 },
    { id: 'pos-leadership', name: 'Leadership', type: 'positive', points: 3 },
    { id: 'pos-improvement', name: 'Notable Improvement', type: 'positive', points: 2 },
    { id: 'neg-late', name: 'Late to Class', type: 'negative', points: -1 },
    { id: 'neg-disruptive', name: 'Disruptive Behaviour', type: 'negative', points: -2 },
    { id: 'neg-uniform', name: 'Uniform Violation', type: 'negative', points: -1 },
    { id: 'neg-fighting', name: 'Fighting', type: 'negative', points: -5 },
    { id: 'neg-absenteeism', name: 'Absenteeism Related', type: 'negative', points: -2 },
  ];
  const insert = db.prepare(`
    INSERT INTO conduct_categories (id, name, type, points, is_active)
    VALUES (?, ?, ?, ?, 1)
  `);
  defaults.forEach((row) => insert.run(row.id, row.name, row.type, row.points));
}

function seedDefaultConductThresholds() {
  const row = db.prepare('SELECT id FROM conduct_thresholds WHERE id = 1').get();
  if (row) return;
  db.prepare(`
    INSERT INTO conduct_thresholds (id, negative_incident_limit, alert_enabled)
    VALUES (1, 3, 1)
  `).run();
}

function seedDefaultTimetablePeriods() {
  const count = Number(db.prepare('SELECT COUNT(*) as count FROM timetable_periods').get()?.count || 0);
  if (count > 0) return;

  const periods = [
    { id: 'p1', name: 'Period 1', start: '07:30', end: '08:10', order: 1 },
    { id: 'p2', name: 'Period 2', start: '08:10', end: '08:50', order: 2 },
    { id: 'p3', name: 'Period 3', start: '08:50', end: '09:30', order: 3 },
    { id: 'break1', name: 'Break', start: '09:30', end: '09:50', order: 4, isBreak: 1 },
    { id: 'p4', name: 'Period 4', start: '09:50', end: '10:30', order: 5 },
    { id: 'p5', name: 'Period 5', start: '10:30', end: '11:10', order: 6 },
    { id: 'p6', name: 'Period 6', start: '11:10', end: '11:50', order: 7 },
    { id: 'lunch', name: 'Lunch', start: '11:50', end: '12:30', order: 8, isBreak: 1 },
    { id: 'p7', name: 'Period 7', start: '12:30', end: '13:10', order: 9 },
    { id: 'p8', name: 'Period 8', start: '13:10', end: '13:50', order: 10 },
  ];
  const insert = db.prepare(`
    INSERT INTO timetable_periods (id, name, start_time, end_time, sort_order, is_break)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  periods.forEach((p) => insert.run(p.id, p.name, p.start, p.end, p.order, p.isBreak || 0));
}

function seedGradeCriteriaForCountry(country) {
  const systems = getGradingSystemsForCountry(country);
  const insert = db.prepare(`
    INSERT INTO grade_criteria (grade, min_score, max_score, points, remark, system)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  systems.forEach((system) => {
    const exists = db.prepare('SELECT 1 FROM grade_criteria WHERE system = ? LIMIT 1').get(system);
    if (exists) return;
    const rows = getDefaultCriteriaForSystem(system);
    if (!rows.length) return;
    rows.forEach((row) => {
      insert.run(row.grade, row.min_score, row.max_score, row.points ?? null, row.remark, system);
    });
  });
}

function bootstrapCurrentDatabase() {
  const ensureColumn = (table, column, definition) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = columns.some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  };

  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'teacher' CHECK(role IN ('admin', 'teacher', 'secretary')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      force_password_change INTEGER NOT NULL DEFAULT 0 CHECK(force_password_change IN (0,1)),
      full_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureColumn('users', 'is_active', 'is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))');
  ensureColumn('users', 'force_password_change', 'force_password_change INTEGER NOT NULL DEFAULT 0 CHECK(force_password_change IN (0,1))');

  // School info table
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'My School',
      address TEXT,
      phone TEXT,
      email TEXT,
      logo TEXT,
      motto TEXT,
      opening_date TEXT,
      school_fees TEXT,
      headteacher_name TEXT,
      headteacher_signature TEXT,
      academic_year_start_date TEXT,
      academic_year_end_date TEXT,
      semester1_start_date TEXT,
      semester1_end_date TEXT,
      semester2_start_date TEXT,
      semester2_end_date TEXT,
      report_card_design TEXT,
      country TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY}',
      school_id TEXT,
      oae_enabled INTEGER NOT NULL DEFAULT 0,
      oae_activated_at DATETIME,
      oae_activated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureColumn('school_info', 'opening_date', 'opening_date TEXT');
  ensureColumn('school_info', 'school_fees', 'school_fees TEXT');
  ensureColumn('school_info', 'headteacher_name', 'headteacher_name TEXT');
  ensureColumn('school_info', 'headteacher_signature', 'headteacher_signature TEXT');
  ensureColumn('school_info', 'academic_year_start_date', 'academic_year_start_date TEXT');
  ensureColumn('school_info', 'academic_year_end_date', 'academic_year_end_date TEXT');
  ensureColumn('school_info', 'semester1_start_date', 'semester1_start_date TEXT');
  ensureColumn('school_info', 'semester1_end_date', 'semester1_end_date TEXT');
  ensureColumn('school_info', 'semester2_start_date', 'semester2_start_date TEXT');
  ensureColumn('school_info', 'semester2_end_date', 'semester2_end_date TEXT');
  ensureColumn('school_info', 'report_card_design', 'report_card_design TEXT');
  ensureColumn('school_info', 'country', `country TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY}'`);
  ensureColumn('school_info', 'school_id', 'school_id TEXT');
  ensureColumn('school_info', 'oae_enabled', 'oae_enabled INTEGER NOT NULL DEFAULT 0');
  ensureColumn('school_info', 'oae_activated_at', 'oae_activated_at DATETIME');
  ensureColumn('school_info', 'oae_activated_by', 'oae_activated_by TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_records (
      id TEXT PRIMARY KEY,
      school_id TEXT,
      country TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY}',
      admin_email TEXT,
      admin_name TEXT,
      plan_kind TEXT NOT NULL CHECK(plan_kind IN ('trial', 'manual_offline', 'digital_online')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'pending_activation', 'active', 'expired', 'failed')),
      activation_code TEXT,
      charge_id TEXT,
      payment_method TEXT,
      payment_channel TEXT,
      amount REAL,
      currency TEXT,
      duration_days INTEGER NOT NULL DEFAULT 0,
      online_features_enabled INTEGER NOT NULL DEFAULT 0 CHECK(online_features_enabled IN (0,1)),
      internal_uid TEXT,
      machine_hash TEXT,
      metadata TEXT,
      activated_at DATETIME,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  migrateGradingTables();

  // Insert default school info if not exists
  const schoolExists = db.prepare('SELECT id FROM school_info WHERE id = 1').get();
  if (!schoolExists) {
    const generatedId = generateSchoolId();
    db.prepare(`
      INSERT INTO school_info (
        id, name, address, phone, email, logo, motto, opening_date, school_fees,
        headteacher_name, headteacher_signature,
        academic_year_start_date, academic_year_end_date,
        semester1_start_date, semester1_end_date,
        semester2_start_date, semester2_end_date,
        country, school_id
      )
      VALUES (1, 'My School', '', '', '', NULL, '', '', '', '', '', '', '', '', '', '', '', ?, ?)
    `).run(DEFAULT_COUNTRY, generatedId);
  }
  const { country } = ensureSchoolIdentity();

  // Classes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      year TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Teacher-class access assignments
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_class_assignments (
      user_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, class_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    )
  `);
  ensureColumn('classes', 'min_subjects', 'min_subjects INTEGER NOT NULL DEFAULT 6');
  ensureColumn('classes', 'max_subjects', 'max_subjects INTEGER NOT NULL DEFAULT 12');

  // Students table
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK(gender IN ('Male', 'Female')),
      date_of_birth TEXT,
      guardian_name TEXT,
      guardian_phone TEXT,
      admission_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    )
  `);

  // Subjects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      is_compulsory INTEGER NOT NULL DEFAULT 1 CHECK(is_compulsory IN (0,1)),
      teacher_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    )
  `);
  ensureColumn('subjects', 'is_compulsory', 'is_compulsory INTEGER NOT NULL DEFAULT 1 CHECK(is_compulsory IN (0,1))');
  ensureColumn('subjects', 'teacher_name', 'teacher_name TEXT');

  // Student subject enrollments (supports optional subjects per student)
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_subjects (
      student_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (student_id, subject_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    )
  `);

  // Exams table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('test', 'midterm', 'endterm')),
      term TEXT NOT NULL,
      year TEXT NOT NULL,
      grading_system TEXT NOT NULL DEFAULT 'normal' CHECK(grading_system IN (${ALL_GRADING_SYSTEMS.map((s) => `'${s}'`).join(', ')})),
      max_score REAL NOT NULL DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    )
  `);

  ensureColumn('exams', 'component_exam_id', 'component_exam_id TEXT');
  ensureColumn('exams', 'component_weight', 'component_weight REAL NOT NULL DEFAULT 0');
  ensureColumn('exams', 'current_weight', 'current_weight REAL NOT NULL DEFAULT 100');
  ensureColumn('exams', 'max_score', 'max_score REAL NOT NULL DEFAULT 100');
  ensureColumn('exams', 'lock_status', "lock_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn('exams', 'locked_at', 'locked_at DATETIME');
  ensureColumn('exams', 'locked_by', 'locked_by TEXT');

  // Exam results table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
      grade TEXT,
      points INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      UNIQUE(exam_id, student_id, subject_id)
    )
  `);

  // Grade criteria table
  db.exec(`
    CREATE TABLE IF NOT EXISTS grade_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grade TEXT NOT NULL,
      min_score REAL NOT NULL,
      max_score REAL NOT NULL,
      points INTEGER,
      remark TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT 'normal' CHECK(system IN (${ALL_GRADING_SYSTEMS.map((s) => `'${s}'`).join(', ')}))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_subject_grading_profiles (
      exam_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      grading_system TEXT NOT NULL CHECK(grading_system IN (${[...ALL_GRADING_SYSTEMS, 'custom'].map((s) => `'${s}'`).join(', ')})),
      custom_criteria TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, subject_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_subject_max_scores (
      exam_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      max_score REAL NOT NULL CHECK(max_score > 0),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, subject_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_merge_sources (
      exam_id TEXT NOT NULL,
      source_exam_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, source_exam_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (source_exam_id) REFERENCES exams(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS promotion_criteria (
      class_id TEXT PRIMARY KEY,
      rule_mode TEXT NOT NULL DEFAULT 'pass_all_exams' CHECK(rule_mode IN (
        'auto_all',
        'pass_all_exams',
        'pass_selected_exams',
        'average_midterm_endterm',
        'average_endterm_only'
      )),
      next_class_id TEXT,
      academic_year TEXT,
      minimum_average REAL NOT NULL DEFAULT 50,
      minimum_pass_score REAL NOT NULL DEFAULT 50,
      selected_exam_ids TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (next_class_id) REFERENCES classes(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS promotion_actions (
      id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL CHECK(action_type IN ('apply_criteria', 'manual_promote', 'manual_demote')),
      class_id TEXT,
      academic_year TEXT,
      criteria_snapshot TEXT,
      student_moves TEXT NOT NULL,
      performed_by TEXT,
      undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0, 1)),
      undone_at DATETIME,
      undone_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conduct_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('positive', 'negative')),
      points INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conduct_incidents (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      incident_type TEXT NOT NULL CHECK(incident_type IN ('positive', 'negative')),
      points INTEGER NOT NULL DEFAULT 0,
      severity TEXT,
      description TEXT,
      recorded_by TEXT,
      incident_date TEXT NOT NULL,
      incident_time TEXT,
      voided INTEGER NOT NULL DEFAULT 0 CHECK(voided IN (0, 1)),
      voided_by TEXT,
      voided_at DATETIME,
      sync_status TEXT DEFAULT 'synced',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES conduct_categories(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conduct_thresholds (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      negative_incident_limit INTEGER NOT NULL DEFAULT 3,
      alert_enabled INTEGER NOT NULL DEFAULT 1 CHECK(alert_enabled IN (0, 1)),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS timetable_periods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_break INTEGER NOT NULL DEFAULT 0 CHECK(is_break IN (0, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS timetable_entries (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      subject_id TEXT,
      teacher_id TEXT,
      period_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      room TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
      academic_year TEXT,
      term TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
      FOREIGN KEY (period_id) REFERENCES timetable_periods(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS academic_calendars (
      id TEXT PRIMARY KEY,
      academic_year TEXT NOT NULL,
      term TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      attendance_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('present', 'absent', 'late', 'excused', 'sick', 'official')),
      reason_note TEXT,
      recorded_by TEXT,
      sync_status TEXT DEFAULT 'synced',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(class_id, student_id, attendance_date),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS device_licenses (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL,
      machine_hash TEXT NOT NULL,
      activation_code TEXT,
      expires_at INTEGER,
      plan_kind TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(school_id, machine_hash)
    )
  `);

  seedDefaultConductCategories();
  seedDefaultConductThresholds();
  seedDefaultTimetablePeriods();

  seedGradeCriteriaForCountry(country);

  // Create indexes for better performance
  if (USE_MYSQL) {
    // Explicit prefix lengths keep composite utf8mb4 indexes under MySQL's 3072-byte limit.
    db.exec(`
      CREATE INDEX idx_students_class ON students(class_id(64));
      CREATE INDEX idx_subjects_class ON subjects(class_id(64));
      CREATE INDEX idx_user_class_assignments_user ON user_class_assignments(user_id(64));
      CREATE INDEX idx_user_class_assignments_class ON user_class_assignments(class_id(64));
      CREATE INDEX idx_subjects_compulsory ON subjects(class_id(64), is_compulsory);
      CREATE INDEX idx_student_subjects_student ON student_subjects(student_id(64));
      CREATE INDEX idx_student_subjects_subject ON student_subjects(subject_id(64));
      CREATE INDEX idx_exams_class ON exams(class_id(64));
      CREATE INDEX idx_results_exam ON exam_results(exam_id(64));
      CREATE INDEX idx_results_student ON exam_results(student_id(64));
      CREATE INDEX idx_exam_subject_profiles_exam ON exam_subject_grading_profiles(exam_id(64));
      CREATE INDEX idx_exam_subject_max_scores_exam ON exam_subject_max_scores(exam_id(64));
      CREATE INDEX idx_exam_merge_sources_exam ON exam_merge_sources(exam_id(64));
      CREATE INDEX idx_subscription_records_status ON subscription_records(status(32));
      CREATE INDEX idx_subscription_records_plan ON subscription_records(plan_kind(32));
      CREATE INDEX idx_subscription_records_charge_id ON subscription_records(charge_id(64));
      CREATE INDEX idx_subscription_records_school_id ON subscription_records(school_id(64));
      CREATE INDEX idx_subscription_records_activation_code ON subscription_records(activation_code(64));
      CREATE INDEX idx_subscription_records_school_status ON subscription_records(school_id(64), status(32), online_features_enabled);
      CREATE INDEX idx_exam_results_exam_student ON exam_results(exam_id(64), student_id(64));
      CREATE INDEX idx_promotion_actions_created ON promotion_actions(created_at);
      CREATE INDEX idx_promotion_criteria_next_class ON promotion_criteria(next_class_id(64));
      CREATE INDEX idx_conduct_incidents_student ON conduct_incidents(student_id(64));
      CREATE INDEX idx_conduct_incidents_class ON conduct_incidents(class_id(64));
      CREATE INDEX idx_conduct_incidents_date ON conduct_incidents(incident_date(32));
      CREATE INDEX idx_timetable_entries_class ON timetable_entries(class_id(64));
      CREATE INDEX idx_attendance_class_date ON attendance_records(class_id(64), attendance_date(32));
      CREATE INDEX idx_attendance_student ON attendance_records(student_id(64));
      CREATE INDEX idx_device_licenses_school ON device_licenses(school_id(64));
      CREATE INDEX idx_subscription_records_internal_uid ON subscription_records(internal_uid(64));
      CREATE INDEX idx_classes_year ON classes(year(32));
    `);
  } else {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
      CREATE INDEX IF NOT EXISTS idx_subjects_class ON subjects(class_id);
      CREATE INDEX IF NOT EXISTS idx_user_class_assignments_user ON user_class_assignments(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_class_assignments_class ON user_class_assignments(class_id);
      CREATE INDEX IF NOT EXISTS idx_subjects_compulsory ON subjects(class_id, is_compulsory);
      CREATE INDEX IF NOT EXISTS idx_student_subjects_student ON student_subjects(student_id);
      CREATE INDEX IF NOT EXISTS idx_student_subjects_subject ON student_subjects(subject_id);
      CREATE INDEX IF NOT EXISTS idx_exams_class ON exams(class_id);
      CREATE INDEX IF NOT EXISTS idx_results_exam ON exam_results(exam_id);
      CREATE INDEX IF NOT EXISTS idx_results_student ON exam_results(student_id);
      CREATE INDEX IF NOT EXISTS idx_exam_subject_profiles_exam ON exam_subject_grading_profiles(exam_id);
      CREATE INDEX IF NOT EXISTS idx_exam_subject_max_scores_exam ON exam_subject_max_scores(exam_id);
      CREATE INDEX IF NOT EXISTS idx_exam_merge_sources_exam ON exam_merge_sources(exam_id);
      CREATE INDEX IF NOT EXISTS idx_subscription_records_status ON subscription_records(status);
      CREATE INDEX IF NOT EXISTS idx_subscription_records_plan ON subscription_records(plan_kind);
      CREATE INDEX IF NOT EXISTS idx_subscription_records_charge_id ON subscription_records(charge_id);
      CREATE INDEX IF NOT EXISTS idx_subscription_records_school_id ON subscription_records(school_id);
      CREATE INDEX IF NOT EXISTS idx_subscription_records_activation_code ON subscription_records(activation_code);
      CREATE INDEX IF NOT EXISTS idx_subscription_records_school_status ON subscription_records(school_id, status, online_features_enabled);
      CREATE INDEX IF NOT EXISTS idx_exam_results_exam_student ON exam_results(exam_id, student_id);
      CREATE INDEX IF NOT EXISTS idx_promotion_actions_created ON promotion_actions(created_at);
      CREATE INDEX IF NOT EXISTS idx_promotion_criteria_next_class ON promotion_criteria(next_class_id);
      CREATE INDEX IF NOT EXISTS idx_conduct_incidents_student ON conduct_incidents(student_id);
      CREATE INDEX IF NOT EXISTS idx_conduct_incidents_class ON conduct_incidents(class_id);
      CREATE INDEX IF NOT EXISTS idx_conduct_incidents_date ON conduct_incidents(incident_date);
      CREATE INDEX IF NOT EXISTS idx_timetable_entries_class ON timetable_entries(class_id);
      CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance_records(class_id, attendance_date);
      CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_records(student_id);
      CREATE INDEX IF NOT EXISTS idx_device_licenses_school ON device_licenses(school_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subscription_records_internal_uid ON subscription_records(internal_uid);
      CREATE INDEX IF NOT EXISTS idx_classes_year_name ON classes(year, name);
    `);
  }

  // Backfill enrollments for existing data: every student gets all compulsory subjects.
  db.exec(`
    INSERT OR IGNORE INTO student_subjects (student_id, subject_id)
    SELECT st.id, sub.id
    FROM students st
    JOIN subjects sub ON sub.class_id = st.class_id
    WHERE sub.is_compulsory = 1
  `);

  ensureInternalUid();
  const identity = ensureSchoolIdentity();
  registerTenantSchool(identity.schoolId, {
    name: db.prepare('SELECT name FROM school_info WHERE id = 1').get()?.name || identity.schoolId,
    source: 'bootstrap',
  });
  console.log('✅ Database initialized successfully');
}

export function initializeDatabase(targetSchoolId = null) {
  resolveDataRoot();
  const normalizedSchoolId = normalizeSchoolId(targetSchoolId || getContextSchoolId());
  if (!normalizedSchoolId) {
    return null;
  }

  return runWithSchoolContext(normalizedSchoolId, () => (
    getTenantConnection(normalizedSchoolId, { allowCreate: true })
  ), { allowCreate: true });
}

export function getInternalUid(targetSchoolId = null) {
  const normalizedSchoolId = normalizeSchoolId(targetSchoolId || getContextSchoolId());
  if (!normalizedSchoolId) {
    throw createTenantError('School ID is required to resolve internal UID.', 400);
  }

  return runWithSchoolContext(normalizedSchoolId, () => ensureInternalUid(), { allowCreate: true });
}

export function resetEducationData(nextCountry) {
  const country = normalizeCountry(nextCountry);
  const schoolRow = db.prepare('SELECT school_id FROM school_info WHERE id = 1').get();
  const schoolId = schoolRow?.school_id || generateSchoolId();

  const wipeTables = [
    'exam_results',
    'exam_subject_grading_profiles',
    'exam_subject_max_scores',
    'exam_merge_sources',
    'exams',
    'student_subjects',
    'subjects',
    'students',
    'classes',
    'user_class_assignments',
    'grade_criteria',
    'subscription_records',
    'users',
  ];

  const tx = db.transaction(() => {
    db.exec('PRAGMA foreign_keys = OFF;');
    wipeTables.forEach((table) => {
      db.prepare(`DELETE FROM ${table}`).run();
    });
    db.exec('PRAGMA foreign_keys = ON;');

    db.prepare(`
      UPDATE school_info
      SET name = 'My School',
          address = '',
          phone = '',
          email = '',
          logo = NULL,
          motto = '',
          opening_date = '',
          school_fees = '',
          headteacher_name = '',
          headteacher_signature = '',
          academic_year_start_date = '',
          academic_year_end_date = '',
          semester1_start_date = '',
          semester1_end_date = '',
          semester2_start_date = '',
          semester2_end_date = '',
          country = ?,
          school_id = ?,
          oae_enabled = 0,
          oae_activated_at = NULL,
          oae_activated_by = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(country, schoolId);
  });
  tx();

  seedGradeCriteriaForCountry(country);

  return { country, schoolId };
}

export function getDatabaseDebugInfo(targetSchoolId = null) {
  const normalizedSchoolId = normalizeSchoolId(targetSchoolId || getContextSchoolId());
  const dataRoot = resolveDataRoot();
  const mysqlTarget = normalizedSchoolId && USE_MYSQL
    ? resolveMysqlConnectionTarget(normalizedSchoolId)
    : null;
  const info = {
    mode: USE_MYSQL ? 'mysql' : 'sqlite',
    mysql_tenant_mode: USE_MYSQL ? resolveMysqlTenantMode() : null,
    data_root: USE_MYSQL ? null : dataRoot,
    requested_school_id: normalizedSchoolId || null,
    mysql_database: mysqlTarget?.database || null,
    mysql_table_prefix: mysqlTarget?.tablePrefix || null,
    sqlite_path: normalizedSchoolId && !USE_MYSQL ? resolveTenantDatabasePath(normalizedSchoolId) : null,
    registered_tenants: listRegisteredTenants(),
    tenant_count: 0,
    known_sqlite_tenants: [],
    snapshot: null,
  };
  info.tenant_count = info.registered_tenants.length;

  if (!USE_MYSQL) {
    try {
      info.known_sqlite_tenants = listSqliteTenantIds();
    } catch (error) {
      info.known_sqlite_tenants_error = error.message || 'Failed to list tenant directories.';
    }
  }

  if (!normalizedSchoolId) {
    return info;
  }

  try {
    info.snapshot = runWithSchoolContext(normalizedSchoolId, () => {
      const tables = [
        'users',
        'school_info',
        'classes',
        'students',
        'subjects',
        'exams',
        'exam_results',
        'subscription_records',
      ];
      const counts = {};
      tables.forEach((table) => {
        try {
          counts[table] = Number(db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get()?.count || 0);
        } catch (error) {
          counts[table] = `error: ${error.message || 'failed'}`;
        }
      });
      const school = db.prepare('SELECT id, name, email, country, school_id, updated_at FROM school_info WHERE id = 1').get() || null;
      const subscriptions = db.prepare(`
        SELECT id, school_id, plan_kind, status, charge_id, payment_method, payment_channel,
               amount, currency, duration_days, online_features_enabled, activated_at,
               expires_at, created_at, updated_at
        FROM subscription_records
        ORDER BY created_at DESC
        LIMIT 20
      `).all();
      return { counts, school, recent_subscriptions: subscriptions };
    }, { allowCreate: false });
  } catch (error) {
    info.snapshot_error = error.message || 'Failed to inspect tenant database.';
  }

  return info;
}

export default db;
