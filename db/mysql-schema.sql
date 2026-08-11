-- Select the target database in phpMyAdmin before running this schema.
-- If you are using a privileged MySQL client, create/select your database first:
-- CREATE DATABASE IF NOT EXISTS oasis_ems CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE oasis_ems;

CREATE TABLE IF NOT EXISTS app_identity (
  id INT PRIMARY KEY,
  encrypted_uid TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(191) UNIQUE NOT NULL,
  email VARCHAR(191) UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'teacher',
  is_active TINYINT NOT NULL DEFAULT 1,
  force_password_change TINYINT NOT NULL DEFAULT 0,
  full_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (role IN ('admin', 'teacher', 'secretary')),
  CHECK (is_active IN (0, 1)),
  CHECK (force_password_change IN (0, 1))
);

CREATE TABLE IF NOT EXISTS school_info (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
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
  country VARCHAR(64) NOT NULL DEFAULT 'Malawi',
  school_id VARCHAR(64),
  oae_enabled TINYINT NOT NULL DEFAULT 0,
  oae_activated_at DATETIME,
  oae_activated_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (id = 1),
  CHECK (oae_enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS subscription_records (
  id VARCHAR(64) PRIMARY KEY,
  school_id VARCHAR(64),
  country VARCHAR(64) NOT NULL DEFAULT 'Malawi',
  admin_email TEXT,
  admin_name TEXT,
  plan_kind VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  activation_code VARCHAR(191),
  charge_id VARCHAR(191),
  payment_method VARCHAR(64),
  payment_channel VARCHAR(64),
  amount DOUBLE,
  currency VARCHAR(16),
  duration_days INT NOT NULL DEFAULT 0,
  online_features_enabled TINYINT NOT NULL DEFAULT 0,
  internal_uid VARCHAR(191),
  machine_hash TEXT,
  metadata LONGTEXT,
  activated_at DATETIME,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_subscription_records_status (status),
  KEY idx_subscription_records_plan (plan_kind),
  KEY idx_subscription_records_charge_id (charge_id),
  KEY idx_subscription_records_school_id (school_id),
  KEY idx_subscription_records_internal_uid (internal_uid),
  KEY idx_subscription_records_activation_code (activation_code),
  KEY idx_subscription_records_school_status (school_id, status, online_features_enabled),
  CHECK (plan_kind IN ('trial', 'manual_offline', 'digital_online')),
  CHECK (status IN ('pending', 'pending_activation', 'active', 'expired', 'failed')),
  CHECK (online_features_enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS classes (
  id VARCHAR(64) PRIMARY KEY,
  name TEXT NOT NULL,
  year TEXT NOT NULL,
  min_subjects INT NOT NULL DEFAULT 6,
  max_subjects INT NOT NULL DEFAULT 12,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_classes_year (year)
);

CREATE TABLE IF NOT EXISTS user_class_assignments (
  user_id VARCHAR(64) NOT NULL,
  class_id VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, class_id),
  KEY idx_user_class_assignments_user (user_id),
  KEY idx_user_class_assignments_class (class_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS students (
  id VARCHAR(64) PRIMARY KEY,
  class_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  gender VARCHAR(16) NOT NULL,
  date_of_birth TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  admission_number TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_students_class (class_id),
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  CHECK (gender IN ('Male', 'Female'))
);

CREATE TABLE IF NOT EXISTS subjects (
  id VARCHAR(64) PRIMARY KEY,
  class_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  is_compulsory TINYINT NOT NULL DEFAULT 1,
  teacher_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_subjects_class (class_id),
  KEY idx_subjects_compulsory (class_id, is_compulsory),
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  CHECK (is_compulsory IN (0, 1))
);

CREATE TABLE IF NOT EXISTS student_subjects (
  student_id VARCHAR(64) NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, subject_id),
  KEY idx_student_subjects_student (student_id),
  KEY idx_student_subjects_subject (subject_id),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exams (
  id VARCHAR(64) PRIMARY KEY,
  class_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  type VARCHAR(32) NOT NULL,
  term TEXT NOT NULL,
  year TEXT NOT NULL,
  grading_system VARCHAR(64) NOT NULL DEFAULT 'normal',
  max_score DOUBLE NOT NULL DEFAULT 100,
  component_exam_id VARCHAR(64),
  component_weight DOUBLE NOT NULL DEFAULT 0,
  current_weight DOUBLE NOT NULL DEFAULT 100,
  lock_status VARCHAR(32) NOT NULL DEFAULT 'none',
  locked_at DATETIME,
  locked_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_exams_class (class_id),
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  CHECK (type IN ('test', 'midterm', 'endterm'))
);

CREATE TABLE IF NOT EXISTS exam_results (
  id INT PRIMARY KEY AUTO_INCREMENT,
  exam_id VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  score DOUBLE NOT NULL,
  grade TEXT,
  points INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_results_exam (exam_id),
  KEY idx_results_student (student_id),
  KEY idx_exam_results_exam_student (exam_id, student_id),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
  UNIQUE KEY uq_exam_results_exam_student_subject (exam_id, student_id, subject_id),
  CHECK (score >= 0 AND score <= 100)
);

CREATE TABLE IF NOT EXISTS grade_criteria (
  id INT PRIMARY KEY AUTO_INCREMENT,
  grade TEXT NOT NULL,
  min_score DOUBLE NOT NULL,
  max_score DOUBLE NOT NULL,
  points INT,
  remark TEXT NOT NULL,
  system VARCHAR(64) NOT NULL DEFAULT 'normal'
);

CREATE TABLE IF NOT EXISTS exam_subject_grading_profiles (
  exam_id VARCHAR(64) NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  grading_system VARCHAR(64) NOT NULL,
  custom_criteria LONGTEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, subject_id),
  KEY idx_exam_subject_profiles_exam (exam_id),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exam_subject_max_scores (
  exam_id VARCHAR(64) NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  max_score DOUBLE NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, subject_id),
  KEY idx_exam_subject_max_scores_exam (exam_id),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exam_merge_sources (
  exam_id VARCHAR(64) NOT NULL,
  source_exam_id VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (exam_id, source_exam_id),
  KEY idx_exam_merge_sources_exam (exam_id),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (source_exam_id) REFERENCES exams(id) ON DELETE CASCADE
);
