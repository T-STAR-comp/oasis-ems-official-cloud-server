import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { authenticateToken, ensureClassAccess, isAdminUser, requireRole } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

router.get('/categories', (_req, res) => {
  const categories = db.prepare(`
    SELECT * FROM conduct_categories
    WHERE is_active = 1
    ORDER BY type DESC, name ASC
  `).all();
  res.json({ categories });
});

router.put('/categories', requireRole('admin'), (req, res) => {
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM conduct_categories').run();
    const insert = db.prepare(`
      INSERT INTO conduct_categories (id, name, type, points, is_active)
      VALUES (?, ?, ?, ?, ?)
    `);
    rows.forEach((row) => {
      insert.run(
        row.id || uuidv4(),
        String(row.name || '').trim(),
        row.type === 'positive' ? 'positive' : 'negative',
        Number(row.points || 0),
        row.is_active === false ? 0 : 1,
      );
    });
  });
  tx(categories);
  res.json({ message: 'Conduct categories updated.' });
});

router.get('/thresholds', requireRole('admin'), (_req, res) => {
  const thresholds = db.prepare('SELECT * FROM conduct_thresholds WHERE id = 1').get()
    || { negative_incident_limit: 3, alert_enabled: 1 };
  res.json({ thresholds });
});

router.put('/thresholds', requireRole('admin'), (req, res) => {
  const limit = Math.max(1, Number(req.body?.negative_incident_limit || 3));
  const alertEnabled = req.body?.alert_enabled === false ? 0 : 1;
  db.prepare(`
    INSERT INTO conduct_thresholds (id, negative_incident_limit, alert_enabled, updated_at)
    VALUES (1, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      negative_incident_limit = excluded.negative_incident_limit,
      alert_enabled = excluded.alert_enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(limit, alertEnabled);
  res.json({ message: 'Conduct thresholds updated.' });
});

router.get('/incidents', (req, res) => {
  const { class_id, student_id, type, from, to, limit = 100 } = req.query;
  const conditions = ['ci.voided = 0'];
  const params = [];

  if (class_id) {
    if (!ensureClassAccess(req, res, class_id)) return;
    conditions.push('ci.class_id = ?');
    params.push(class_id);
  } else if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Class filter is required for teachers.' });
  }

  if (student_id) {
    conditions.push('ci.student_id = ?');
    params.push(student_id);
  }
  if (type) {
    conditions.push('ci.incident_type = ?');
    params.push(type);
  }
  if (from) {
    conditions.push('ci.incident_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('ci.incident_date <= ?');
    params.push(to);
  }

  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const incidents = db.prepare(`
    SELECT ci.*, s.name as student_name, cc.name as category_name, c.name as class_name
    FROM conduct_incidents ci
    JOIN students s ON s.id = ci.student_id
    JOIN conduct_categories cc ON cc.id = ci.category_id
    JOIN classes c ON c.id = ci.class_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ci.incident_date DESC, ci.created_at DESC
    LIMIT ?
  `).all(...params, max);

  res.json({ incidents });
});

router.post('/incidents', (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body || {}];
  const created = [];

  const insert = db.prepare(`
    INSERT INTO conduct_incidents (
      id, student_id, class_id, category_id, incident_type, points, severity,
      description, recorded_by, incident_date, incident_time, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of entries) {
    const student = db.prepare('SELECT id, class_id FROM students WHERE id = ?').get(entry.student_id);
    if (!student) {
      return res.status(400).json({ error: 'Student not found.' });
    }
    if (!ensureClassAccess(req, res, student.class_id)) return;

    const category = db.prepare('SELECT * FROM conduct_categories WHERE id = ? AND is_active = 1').get(entry.category_id);
    if (!category) {
      return res.status(400).json({ error: 'Conduct category not found.' });
    }

    const id = uuidv4();
    const now = new Date();
    const incidentDate = String(entry.incident_date || now.toISOString().slice(0, 10));
    const incidentTime = String(entry.incident_time || now.toTimeString().slice(0, 8));
    const points = Number(entry.points ?? category.points ?? 0);

    insert.run(
      id,
      student.id,
      student.class_id,
      category.id,
      category.type,
      points,
      entry.severity || null,
      String(entry.description || '').trim() || null,
      req.user.full_name || req.user.username || req.user.id,
      incidentDate,
      incidentTime,
      entry.sync_status || 'synced',
    );
    created.push(id);
  }

  res.status(201).json({ message: `Logged ${created.length} conduct record(s).`, ids: created });
});

router.patch('/incidents/:id', requireRole('admin'), (req, res) => {
  const incident = db.prepare('SELECT * FROM conduct_incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found.' });

  if (req.body?.void === true) {
    db.prepare(`
      UPDATE conduct_incidents
      SET voided = 1, voided_by = ?, voided_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.user.full_name || req.user.username || req.user.id, req.params.id);
    return res.json({ message: 'Incident voided.' });
  }

  db.prepare(`
    UPDATE conduct_incidents
    SET description = COALESCE(?, description),
        points = COALESCE(?, points),
        severity = COALESCE(?, severity)
    WHERE id = ?
  `).run(
    req.body?.description ?? null,
    req.body?.points ?? null,
    req.body?.severity ?? null,
    req.params.id,
  );
  res.json({ message: 'Incident updated.' });
});

router.get('/students/:studentId/summary', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (!ensureClassAccess(req, res, student.class_id)) return;

  const summary = db.prepare(`
    SELECT
      SUM(CASE WHEN incident_type = 'positive' THEN 1 ELSE 0 END) as positive_count,
      SUM(CASE WHEN incident_type = 'negative' THEN 1 ELSE 0 END) as negative_count,
      SUM(points) as points_balance
    FROM conduct_incidents
    WHERE student_id = ? AND voided = 0
  `).get(student.id);

  const timeline = db.prepare(`
    SELECT ci.*, cc.name as category_name
    FROM conduct_incidents ci
    JOIN conduct_categories cc ON cc.id = ci.category_id
    WHERE ci.student_id = ? AND ci.voided = 0
    ORDER BY ci.incident_date DESC, ci.created_at DESC
    LIMIT 50
  `).all(student.id);

  res.json({ student, summary, timeline });
});

export default router;
