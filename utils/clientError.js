const MYSQL_CLIENT_MESSAGES = {
  ER_DBACCESS_DENIED_ERROR: 'Cloud database access is misconfigured. Contact your administrator.',
  ER_ACCESS_DENIED_ERROR: 'Cloud database login failed. Check server configuration.',
  ER_BAD_DB_ERROR: 'Cloud database is not available. Contact your administrator.',
  ECONNREFUSED: 'Cloud database is unavailable. Try again later.',
  ENOTFOUND: 'Cloud database host could not be reached.',
  ETIMEDOUT: 'Cloud database connection timed out. Try again later.',
};

export function extractMysqlErrorCode(error) {
  if (error?.code && String(error.code).startsWith('ER_')) {
    return error.code;
  }
  const match = String(error?.message || '').match(/\b(ER_[A-Z0-9_]+)\b/);
  return match?.[1] || null;
}

export function isDatabaseError(error) {
  const code = extractMysqlErrorCode(error);
  if (code) return true;
  return Boolean(error?.sqlMessage || error?.sqlState || String(error?.message || '').includes('SQLITE_'));
}

export function resolveClientError(error) {
  const statusCode = Number(error?.statusCode || error?.status) || 500;
  const mysqlCode = extractMysqlErrorCode(error);

  if (mysqlCode && MYSQL_CLIENT_MESSAGES[mysqlCode]) {
    return {
      statusCode: 503,
      message: MYSQL_CLIENT_MESSAGES[mysqlCode],
    };
  }

  if (isDatabaseError(error)) {
    return {
      statusCode: 503,
      message: 'A database error occurred. Try again later.',
    };
  }

  if (error?.expose === true || statusCode < 500) {
    return {
      statusCode,
      message: error?.message || 'Request failed.',
    };
  }

  if (process.env.NODE_ENV === 'development') {
    return {
      statusCode,
      message: error?.message || 'Internal server error',
    };
  }

  return {
    statusCode,
    message: 'An unexpected error occurred. Try again later.',
  };
}
