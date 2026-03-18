import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import {
  DEFAULT_COUNTRY,
  normalizeCountry,
  ALL_GRADING_SYSTEMS,
  getDefaultCriteriaForSystem,
  getDefaultClassesForCountry,
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

function resolveDatabasePath() {
  const legacyDbPath = path.join(__dirname, 'school.db');
  const preferredDir = process.env.OASIS_DATA_DIR
    ? path.resolve(process.env.OASIS_DATA_DIR)
    : __dirname;
  ensureDirectory(preferredDir);
  const preferredDbPath = path.join(preferredDir, 'school.db');

  // First run on desktop: migrate existing DB from server/db into writable app data dir.
  if (preferredDbPath !== legacyDbPath && !fs.existsSync(preferredDbPath)) {
    copyIfExists(legacyDbPath, preferredDbPath);
    copyIfExists(`${legacyDbPath}-wal`, `${preferredDbPath}-wal`);
    copyIfExists(`${legacyDbPath}-shm`, `${preferredDbPath}-shm`);
  }

  return preferredDbPath;
}

const dbPath = resolveDatabasePath();
const db = new Database(dbPath);
const UID_SECRET = process.env.OASIS_UID_SECRET || '';
if (!UID_SECRET.trim()) {
  throw new Error('Missing OASIS_UID_SECRET environment variable.');
}

// Enable foreign keys and WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function uidSecretKey() {
  return crypto.createHash('sha256').update(UID_SECRET).digest();
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
      INSERT INTO school_info (id, name, address, phone, email, logo, motto, opening_date, school_fees, headteacher_name, headteacher_signature, country, school_id)
      VALUES (1, 'My School', '', '', '', NULL, '', '', '', '', '', ?, ?)
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
  } catch (error) {
    console.error('Failed to migrate grading tables:', error);
  }
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

function seedDefaultClasses(country) {
  const templates = getDefaultClassesForCountry(country);
  if (!templates.length) return;

  const insertClass = db.prepare(`
    INSERT INTO classes (id, name, year, min_subjects, max_subjects)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSubject = db.prepare(`
    INSERT INTO subjects (id, class_id, name, code, is_compulsory, teacher_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    templates.forEach((template) => {
      const classId = crypto.randomUUID();
      insertClass.run(
        classId,
        template.name,
        template.year,
        Number(template.min_subjects || 6),
        Number(template.max_subjects || 12)
      );
      template.subjects.forEach((subject) => {
        const subjectId = crypto.randomUUID();
        insertSubject.run(
          subjectId,
          classId,
          subject.name,
          subject.code,
          Number(subject.is_compulsory || 0),
          null
        );
      });
    });
  });
  tx();
}

export function initializeDatabase() {
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
      country TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY}',
      school_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureColumn('school_info', 'opening_date', 'opening_date TEXT');
  ensureColumn('school_info', 'school_fees', 'school_fees TEXT');
  ensureColumn('school_info', 'headteacher_name', 'headteacher_name TEXT');
  ensureColumn('school_info', 'headteacher_signature', 'headteacher_signature TEXT');
  ensureColumn('school_info', 'country', `country TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY}'`);
  ensureColumn('school_info', 'school_id', 'school_id TEXT');

  migrateGradingTables();

  // Insert default school info if not exists
  const schoolExists = db.prepare('SELECT id FROM school_info WHERE id = 1').get();
  if (!schoolExists) {
    const generatedId = generateSchoolId();
    db.prepare(`
      INSERT INTO school_info (id, name, address, phone, email, logo, motto, opening_date, school_fees, headteacher_name, headteacher_signature, country, school_id)
      VALUES (1, 'My School', '', '', '', NULL, '', '', '', '', '', ?, ?)
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

  seedGradeCriteriaForCountry(country);

  // Create indexes for better performance
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
  `);

  // Backfill enrollments for existing data: every student gets all compulsory subjects.
  db.exec(`
    INSERT OR IGNORE INTO student_subjects (student_id, subject_id)
    SELECT st.id, sub.id
    FROM students st
    JOIN subjects sub ON sub.class_id = st.class_id
    WHERE sub.is_compulsory = 1
  `);

  const classExists = db.prepare('SELECT id FROM classes LIMIT 1').get();
  if (!classExists) {
    seedDefaultClasses(country);
  }

  // Create default admin user if no users exist
  const userExists = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!userExists) {
    const hashedPassword = bcrypt.hashSync('admin123', 12);
    db.prepare(`
      INSERT INTO users (id, username, email, password, role, full_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('admin-001', 'admin', 'admin@school.com', hashedPassword, 'admin', 'System Administrator');
    
    console.log('📝 Default admin created: username=admin, password=admin123');
  }

  ensureInternalUid();
  ensureSchoolIdentity();
  console.log('✅ Database initialized successfully');
}

export function getInternalUid() {
  return ensureInternalUid();
}

export function resetEducationData(nextCountry) {
  const country = normalizeCountry(nextCountry);
  const schoolRow = db.prepare('SELECT school_id FROM school_info WHERE id = 1').get();
  const schoolId = schoolRow?.school_id || generateSchoolId();

  const wipeTables = [
    'exam_results',
    'exam_subject_grading_profiles',
    'exams',
    'student_subjects',
    'subjects',
    'students',
    'classes',
    'user_class_assignments',
    'grade_criteria',
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
          country = ?,
          school_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(country, schoolId);
  });
  tx();

  const hashedPassword = bcrypt.hashSync('admin123', 12);
  db.prepare(`
    INSERT INTO users (id, username, email, password, role, full_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('admin-001', 'admin', 'admin@school.com', hashedPassword, 'admin', 'System Administrator');

  seedGradeCriteriaForCountry(country);
  seedDefaultClasses(country);

  return { country, schoolId };
}

export default db;
