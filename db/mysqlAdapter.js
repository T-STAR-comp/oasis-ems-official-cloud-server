import MySql from 'sync-mysql';

export const TENANT_TABLE_NAMES = [
  'exam_subject_grading_profiles',
  'exam_merge_sources',
  'promotion_criteria',
  'promotion_actions',
  'user_class_assignments',
  'subscription_records',
  'student_subjects',
  'grade_criteria',
  'exam_results',
  'school_info',
  'app_identity',
  'students',
  'subjects',
  'classes',
  'exams',
  'users',
];

function toBooleanEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getConfig(database) {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database,
    charset: process.env.MYSQL_CHARSET || 'utf8mb4',
  };
}

function quoteIdentifier(value) {
  return `\`${String(value || '').replace(/`/g, '``')}\``;
}

function splitStatements(sql) {
  return String(sql || '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function normalizeStatement(sql) {
  let next = String(sql || '').trim();

  if (!next || /^PRAGMA\b/i.test(next)) {
    return '';
  }

  next = next
    .replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT')
    .replace(/\bCREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE INDEX')
    .replace(/\b(id|user_id|class_id|next_class_id|student_id|subject_id|exam_id|source_exam_id|school_id|username|email|country|plan_kind|status|activation_code|charge_id|payment_method|payment_channel|currency|type|role|gender|grading_system|lock_status|system|internal_uid)\s+TEXT\b/gi, '$1 VARCHAR(191)')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTO_INCREMENT\b/gi, 'INT PRIMARY KEY AUTO_INCREMENT')
    .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE')
    .replace(/\bdatetime\(([^)]+)\)/gi, '$1')
    .replace(/,\s*rowid\s+DESC/gi, '')
    .replace(/\browid\s+DESC,?\s*/gi, '')
    .replace(/\bexcluded\./gi, 'VALUES(');

  next = next.replace(/VALUES\((\w+)\b/gi, 'VALUES($1)');
  next = next.replace(/ON\s+CONFLICT\s*\([^)]+\)\s*DO\s+UPDATE\s+SET/gi, 'ON DUPLICATE KEY UPDATE');
  next = next.replace(/id\s+INTEGER\s+PRIMARY\s+KEY\s+CHECK\s*\([^)]+\)/gi, 'id INT PRIMARY KEY');

  return next;
}

function mapRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function mapInfo(result) {
  return {
    changes: Number(result?.affectedRows || 0),
    lastInsertRowid: Number(result?.insertId || 0) || undefined,
  };
}

export function applyTablePrefix(sql, tablePrefix) {
  if (!tablePrefix) {
    return String(sql || '');
  }

  let next = String(sql || '');
  const tables = [...TENANT_TABLE_NAMES].sort((left, right) => right.length - left.length);

  tables.forEach((table) => {
    const prefixed = `${tablePrefix}_${table}`;
    next = next.replace(new RegExp(`\`${escapeRegex(table)}\``, 'gi'), `\`${prefixed}\``);
    next = next.replace(new RegExp(`\\b${escapeRegex(table)}_old_fkfix\\b`, 'gi'), `${prefixed}_old_fkfix`);
    next = next.replace(new RegExp(`\\b${escapeRegex(table)}_old\\b`, 'gi'), `${prefixed}_old`);
    next = next.replace(new RegExp(`\\b${escapeRegex(table)}\\b`, 'gi'), prefixed);
  });

  return next;
}

export function isMysqlEnabled() {
  return toBooleanEnv(process.env.OASIS_USE_MYSQL);
}

export function resolveMysqlTenantMode() {
  const explicit = String(process.env.OASIS_MYSQL_TENANT_MODE || '').trim().toLowerCase();
  if (explicit === 'database' || explicit === 'shared') {
    return explicit;
  }

  // cPanel and most shared hosts grant one MySQL database — isolate schools by table prefix.
  if (String(process.env.MYSQL_DATABASE || '').trim()) {
    return 'shared';
  }

  return 'database';
}

export function resolveMysqlDatabaseName(schoolId) {
  const prefix = String(
    process.env.MYSQL_DATABASE_PREFIX
    || 'oasis_ems',
  ).trim().replace(/[^a-z0-9_]/gi, '_').replace(/^_+|_+$/g, '') || 'oasis_ems';
  const suffix = String(schoolId || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}_${suffix || 'default'}`;
}

export function resolveMysqlTablePrefix(schoolId) {
  const suffix = String(schoolId || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
  return `ems_${suffix}`.slice(0, 40);
}

export function resolveMysqlConnectionTarget(schoolId) {
  const mode = resolveMysqlTenantMode();
  if (mode === 'shared') {
    const database = String(process.env.MYSQL_DATABASE || '').trim();
    if (!database) {
      throw new Error('MYSQL_DATABASE is required when using shared MySQL tenant mode.');
    }
    return {
      mode,
      database,
      tablePrefix: resolveMysqlTablePrefix(schoolId),
    };
  }

  return {
    mode,
    database: resolveMysqlDatabaseName(schoolId),
    tablePrefix: null,
  };
}

export function isLegacySharedMysqlDatabaseConfigured() {
  return resolveMysqlTenantMode() === 'shared';
}

export function ensureMysqlDatabase(databaseName) {
  const admin = new MySql(getConfig(undefined));
  admin.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  admin.dispose();
}

export function ensureMysqlSharedDatabase(databaseName) {
  const connection = new MySql(getConfig(databaseName));
  connection.query('SELECT 1 AS ok');
  connection.dispose();
}

function resolvePhysicalTableName(tableName, tablePrefix) {
  if (!tablePrefix) {
    return tableName;
  }
  return `${tablePrefix}_${tableName}`;
}

export class MysqlCompatConnection {
  constructor(databaseName, { tablePrefix = null } = {}) {
    this.databaseName = databaseName;
    this.tablePrefix = tablePrefix;
    this.connection = new MySql(getConfig(databaseName));
  }

  finalizeSql(sql) {
    const normalized = normalizeStatement(sql);
    if (!normalized) {
      return '';
    }
    return applyTablePrefix(normalized, this.tablePrefix);
  }

  pragma() {}

  close() {
    this.connection.dispose();
  }

  exec(sql) {
    splitStatements(sql).forEach((statement) => {
      const finalized = this.finalizeSql(statement);
      if (finalized) {
        try {
          this.connection.query(finalized);
        } catch (error) {
          if (error?.code !== 'ER_DUP_KEYNAME') {
            throw error;
          }
        }
      }
    });
  }

  prepare(sql) {
    const connection = this.connection;
    const rawSql = String(sql || '').trim();
    const tablePrefix = this.tablePrefix;

    if (/^PRAGMA\s+table_info\(([^)]+)\)/i.test(rawSql)) {
      const tableName = rawSql.match(/^PRAGMA\s+table_info\(([^)]+)\)/i)?.[1];
      const physicalTable = resolvePhysicalTableName(tableName, tablePrefix);
      return {
        all: () => mapRows(connection.query(`SHOW COLUMNS FROM ${quoteIdentifier(physicalTable)}`))
          .map((row) => ({ name: row.Field, type: row.Type, notnull: row.Null === 'NO' ? 1 : 0 })),
        get: () => undefined,
        run: () => ({ changes: 0 }),
      };
    }

    if (/^PRAGMA\s+foreign_key_list\(([^)]+)\)/i.test(rawSql)) {
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
      };
    }

    if (/FROM\s+sqlite_master/i.test(rawSql)) {
      return {
        get: (tableName) => {
          const physicalTable = resolvePhysicalTableName(tableName, tablePrefix);
          const rows = connection.query('SHOW TABLES LIKE ?', [physicalTable]);
          return rows.length ? { sql: '' } : undefined;
        },
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    }

    const finalized = this.finalizeSql(rawSql);
    return {
      run: (...params) => mapInfo(connection.query(finalized, params)),
      get: (...params) => mapRows(connection.query(finalized, params))[0],
      all: (...params) => mapRows(connection.query(finalized, params)),
    };
  }

  transaction(fn) {
    return (...args) => {
      this.connection.query('START TRANSACTION');
      try {
        const result = fn(...args);
        this.connection.query('COMMIT');
        return result;
      } catch (error) {
        this.connection.query('ROLLBACK');
        throw error;
      }
    };
  }
}
