import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import db from '../db/database.js';
import { generateToken, authenticateToken, requireRole } from '../middleware/auth.js';
import { userValidation } from '../middleware/validate.js';

const router = express.Router();

// Login
router.post('/login', userValidation.login, async (req, res, next) => {
  try {
    const { username, password } = req.body;

    // Find user by username or email
    const user = db.prepare(
      'SELECT * FROM users WHERE username = ? OR email = ?'
    ).get(username, username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (Number(user.is_active || 0) !== 1) {
      return res.status(403).json({ error: 'Account is inactive. Please contact admin.' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        is_active: Number(user.is_active || 1) === 1,
        force_password_change: Number(user.force_password_change || 0) === 1
      },
      token
    });
  } catch (error) {
    next(error);
  }
});

// Get current user profile
router.get('/me', authenticateToken, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, email, role, full_name, is_active, force_password_change, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    user: {
      ...user,
      is_active: Number(user.is_active || 1) === 1,
      force_password_change: Number(user.force_password_change || 0) === 1
    }
  });
});

// Update current user profile (email/full name)
router.put('/me', authenticateToken, (req, res, next) => {
  try {
    const { email, full_name } = req.body;
    const updates = [];
    const values = [];

    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalizedEmail, req.user.id);
      if (existing) {
        return res.status(409).json({ error: 'Email is already in use' });
      }
      updates.push('email = ?');
      values.push(normalizedEmail);
    }

    if (full_name !== undefined) {
      updates.push('full_name = ?');
      values.push(String(full_name || '').trim() || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No profile fields provided' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const user = db.prepare(
      'SELECT id, username, email, role, full_name, is_active, force_password_change, created_at FROM users WHERE id = ?'
    ).get(req.user.id);

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        is_active: Number(user.is_active || 1) === 1,
        force_password_change: Number(user.force_password_change || 0) === 1
      }
    });
  } catch (error) {
    next(error);
  }
});

// Update current user password
router.put('/password', authenticateToken, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    
    db.prepare('UPDATE users SET password = ?, force_password_change = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(hashedPassword, req.user.id);

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
});

// Get all users (admin only)
router.get('/users', authenticateToken, requireRole('admin'), (req, res) => {
  const users = db.prepare(`
    SELECT id, username, email, role, full_name, is_active, force_password_change, created_at
    FROM users
    ORDER BY created_at DESC
  `).all();
  const assignments = db.prepare(`
    SELECT user_id, class_id
    FROM user_class_assignments
  `).all();
  const byUser = new Map();
  assignments.forEach((row) => {
    const list = byUser.get(row.user_id) || [];
    list.push(row.class_id);
    byUser.set(row.user_id, list);
  });
  const hydrated = users.map((user) => ({
    ...user,
    is_active: Number(user.is_active || 1) === 1,
    force_password_change: Number(user.force_password_change || 0) === 1,
    assigned_class_ids: byUser.get(user.id) || []
  }));
  res.json({ users: hydrated });
});

// Admin create user and assign classes
router.post('/users', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const { username, email, password, full_name, role = 'teacher', class_ids = [] } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }
    if (!['teacher', 'secretary', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (!Array.isArray(class_ids)) {
      return res.status(400).json({ error: 'class_ids must be an array' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const classSet = Array.from(new Set(class_ids));
    if (classSet.length > 0) {
      const found = db.prepare(`
        SELECT id FROM classes WHERE id IN (${classSet.map(() => '?').join(',')})
      `).all(...classSet);
      if (found.length !== classSet.length) {
        return res.status(400).json({ error: 'One or more class IDs are invalid' });
      }
    }

    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 12);
    const createUser = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, username, email, password, role, full_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, username, email, hashedPassword, role, full_name || null);

      const assignClass = db.prepare(`
        INSERT OR IGNORE INTO user_class_assignments (user_id, class_id)
        VALUES (?, ?)
      `);
      classSet.forEach((classId) => assignClass.run(userId, classId));
    });
    createUser();

    const user = db.prepare(`
      SELECT id, username, email, role, full_name
      FROM users
      WHERE id = ?
    `).get(userId);
    res.status(201).json({
      message: 'User created successfully',
      user: {
        ...user,
        is_active: true,
        force_password_change: false,
        assigned_class_ids: classSet
      }
    });
  } catch (error) {
    next(error);
  }
});

// Update user class assignments
router.put('/users/:id/classes', authenticateToken, requireRole('admin'), (req, res, next) => {
  try {
    const { id } = req.params;
    const { class_ids = [] } = req.body;
    if (!Array.isArray(class_ids)) {
      return res.status(400).json({ error: 'class_ids must be an array' });
    }
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admin class assignments are not required' });
    }

    const classSet = Array.from(new Set(class_ids));
    if (classSet.length > 0) {
      const found = db.prepare(`
        SELECT id FROM classes WHERE id IN (${classSet.map(() => '?').join(',')})
      `).all(...classSet);
      if (found.length !== classSet.length) {
        return res.status(400).json({ error: 'One or more class IDs are invalid' });
      }
    }

    const updateAssignments = db.transaction(() => {
      db.prepare('DELETE FROM user_class_assignments WHERE user_id = ?').run(id);
      const assignClass = db.prepare(`
        INSERT OR IGNORE INTO user_class_assignments (user_id, class_id)
        VALUES (?, ?)
      `);
      classSet.forEach((classId) => assignClass.run(id, classId));
    });
    updateAssignments();

    res.json({
      message: 'User class assignments updated',
      user_id: id,
      assigned_class_ids: classSet
    });
  } catch (error) {
    next(error);
  }
});

// Update user active status
router.put('/users/:id/status', authenticateToken, requireRole('admin'), (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }
    const existing = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (existing.role === 'admin') {
      return res.status(400).json({ error: 'Admin status cannot be changed here' });
    }
    db.prepare('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(is_active ? 1 : 0, id);
    res.json({ message: 'User status updated', user_id: id, is_active });
  } catch (error) {
    next(error);
  }
});

// Admin temporary password reset
router.post('/users/:id/reset-password', authenticateToken, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (existing.role === 'admin') {
      return res.status(400).json({ error: 'Admin password reset is not allowed here' });
    }
    const tempPassword = `TMP-${crypto.randomBytes(4).toString('hex')}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    db.prepare(`
      UPDATE users
      SET password = ?, force_password_change = 1, is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(hashedPassword, id);
    res.json({
      message: 'Temporary password generated',
      user_id: id,
      temporary_password: tempPassword
    });
  } catch (error) {
    next(error);
  }
});

// Delete user (admin only)
router.delete('/users/:id', authenticateToken, requireRole('admin'), (req, res) => {
  const { id } = req.params;

  if (id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ message: 'User deleted successfully' });
});

export default router;
