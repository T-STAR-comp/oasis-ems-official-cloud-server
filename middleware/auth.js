import jwt from 'jsonwebtoken';
import db from '../db/database.js';
import { assertTeacherAccessPolicy, normalizeSchoolId } from '../utils/accessPolicy.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production-2024';
const JWT_EXPIRES_IN = '24h';

export function generateToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      role: user.role,
      school_id: normalizeSchoolId(user.school_id),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const schoolId = normalizeSchoolId(decoded?.school_id);
    if (!schoolId) {
      return res.status(401).json({ error: 'Session is missing school context. Please login again.' });
    }
    
    // Verify user still exists in database
    const user = db.prepare('SELECT id, username, role, email, full_name, is_active, force_password_change FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }
    if (Number(user.is_active || 0) !== 1) {
      return res.status(403).json({ error: 'Account is inactive. Please contact admin.' });
    }

    await assertTeacherAccessPolicy(user);

    req.user = {
      ...user,
      school_id: schoolId,
    };
    next();
  } catch (error) {
    if (typeof error?.status === 'number') {
      return res.status(error.status).json({ error: error.message || 'Access denied' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: roles,
        current: req.user.role
      });
    }

    next();
  };
}

export function isAdminUser(user) {
  return user?.role !== 'teacher';
}

export function getAssignedClassIds(userId) {
  return db.prepare(`
    SELECT class_id
    FROM user_class_assignments
    WHERE user_id = ?
  `).all(userId).map((row) => row.class_id);
}

export function canAccessClass(user, classId) {
  if (!user || !classId) return false;
  if (isAdminUser(user)) return true;
  const row = db.prepare(`
    SELECT 1
    FROM user_class_assignments
    WHERE user_id = ? AND class_id = ?
    LIMIT 1
  `).get(user.id, classId);
  return !!row;
}

export function ensureClassAccess(req, res, classId) {
  if (!canAccessClass(req.user, classId)) {
    res.status(403).json({ error: 'You are not allowed to access this class' });
    return false;
  }
  return true;
}

// Middleware for optional authentication (public routes that benefit from auth)
export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (error) {
      // Token invalid, but route is optional auth, so continue
    }
  }

  next();
}

export { JWT_SECRET };
