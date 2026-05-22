import MySql from 'sync-mysql';

function toBooleanEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
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
    .replace(/\b(id|user_id|class_id|student_id|subject_id|exam_id|source_exam_id|school_id|username|email|country|plan_kind|status|activation_code|charge_id|payment_method|payment_channel|currency|type|role|gender|grading_system|lock_status|system)\s+TEXT\b/gi, '$1 VARCHAR(191)')
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

export function isMysqlEnabled() {
  return toBooleanEnv(process.env.OASIS_USE_MYSQL);
}

export function resolveMysqlDatabaseName(schoolId) {
  const explicitDatabase = String(process.env.MYSQL_DATABASE || '').trim();
  if (explicitDatabase) return explicitDatabase;
  const prefix = String(process.env.MYSQL_DATABASE_PREFIX || 'oasis_ems').trim();
  const suffix = String(schoolId || 'default').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${prefix}_${suffix || 'default'}`;
}

export function ensureMysqlDatabase(databaseName) {
  const admin = new MySql(getConfig(undefined));
  admin.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  admin.dispose();
}

export class MysqlCompatConnection {
  constructor(databaseName) {
    this.databaseName = databaseName;
    this.connection = new MySql(getConfig(databaseName));
  }

  pragma() {}

  close() {
    this.connection.dispose();
  }

  exec(sql) {
    splitStatements(sql).forEach((statement) => {
      const normalized = normalizeStatement(statement);
      if (normalized) {
        try {
          this.connection.query(normalized);
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

    if (/^PRAGMA\s+table_info\(([^)]+)\)/i.test(rawSql)) {
      const tableName = rawSql.match(/^PRAGMA\s+table_info\(([^)]+)\)/i)?.[1];
      return {
        all: () => mapRows(connection.query(`SHOW COLUMNS FROM ${quoteIdentifier(tableName)}`))
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
          const rows = connection.query('SHOW TABLES LIKE ?', [tableName]);
          return rows.length ? { sql: '' } : undefined;
        },
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    }

    const normalized = normalizeStatement(rawSql);
    return {
      run: (...params) => mapInfo(connection.query(normalized, params)),
      get: (...params) => mapRows(connection.query(normalized, params))[0],
      all: (...params) => mapRows(connection.query(normalized, params)),
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
