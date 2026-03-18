import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

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
  const defaultCloudDir = process.env.VERCEL ? '/tmp/oasis-data' : __dirname;
  const preferredDir = process.env.OASIS_DATA_DIR
    ? path.resolve(process.env.OASIS_DATA_DIR)
    : defaultCloudDir;
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureColumn('school_info', 'opening_date', 'opening_date TEXT');
  ensureColumn('school_info', 'school_fees', 'school_fees TEXT');
  ensureColumn('school_info', 'headteacher_name', 'headteacher_name TEXT');
  ensureColumn('school_info', 'headteacher_signature', 'headteacher_signature TEXT');

  // Insert default school info if not exists
  const schoolExists = db.prepare('SELECT id FROM school_info WHERE id = 1').get();
  if (!schoolExists) {
    db.prepare(`
      INSERT INTO school_info (id, name, address, phone, email, logo, motto, opening_date, school_fees, headteacher_name, headteacher_signature)
      VALUES (1, 'My School', '', '', '', NULL, '', '', '', '', '')
    `).run();
  }

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
      grading_system TEXT NOT NULL DEFAULT 'normal' CHECK(grading_system IN ('normal', 'msce')),
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
      system TEXT NOT NULL DEFAULT 'normal' CHECK(system IN ('normal', 'msce'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_subject_grading_profiles (
      exam_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      grading_system TEXT NOT NULL CHECK(grading_system IN ('normal', 'msce', 'custom')),
      custom_criteria TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (exam_id, subject_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    )
  `);

  // Insert default grade criteria if not exists
  const criteriaExists = db.prepare('SELECT id FROM grade_criteria LIMIT 1').get();
  if (!criteriaExists) {
    // Normal grading
    const insertCriteria = db.prepare(`
      INSERT INTO grade_criteria (grade, min_score, max_score, remark, system)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    insertCriteria.run('A', 80, 100, 'Excellent', 'normal');
    insertCriteria.run('B', 65, 79, 'Very Good', 'normal');
    insertCriteria.run('C', 50, 64, 'Good', 'normal');
    insertCriteria.run('D', 40, 49, 'Satisfactory', 'normal');
    insertCriteria.run('E', 30, 39, 'Fair', 'normal');
    insertCriteria.run('F', 0, 29, 'Fail', 'normal');

    // MSCE points
    const insertMSCE = db.prepare(`
      INSERT INTO grade_criteria (grade, min_score, max_score, points, remark, system)
      VALUES (?, ?, ?, ?, ?, 'msce')
    `);
    
    insertMSCE.run('1', 75, 100, 1, 'Distinction');
    insertMSCE.run('2', 70, 74, 2, 'Distinction');
    insertMSCE.run('3', 65, 69, 3, 'Credit');
    insertMSCE.run('4', 60, 64, 4, 'Credit');
    insertMSCE.run('5', 55, 59, 5, 'Credit');
    insertMSCE.run('6', 50, 54, 6, 'Pass');
    insertMSCE.run('7', 40, 49, 7, 'Pass');
    insertMSCE.run('8', 30, 39, 8, 'Fail');
    insertMSCE.run('9', 0, 29, 9, 'Fail');
  }

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
  console.log('✅ Database initialized successfully');
}

export function getInternalUid() {
  return ensureInternalUid();
}

export default db;
