const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireAdmin, canAccessTask } = require('../middleware/auth');

async function taskFormLookups() {
  return {
    staffList: await db.prepare(`SELECT id, name, role, designation FROM users WHERE active = 1 ORDER BY role, name`).all(),
    batches: await db.prepare(`SELECT id, name FROM batches ORDER BY start_date DESC, name`).all(),
    // Shown as "Person Name (Course)" so an admin can tell apart a person's different
    // enrollments when assigning a task to a specific course.
    students: await db.prepare(`
      SELECT e.id, p.person_code AS student_code, p.name, e.course
      FROM enrollments e JOIN persons p ON p.id = e.person_id
      WHERE e.status = 'active'
      ORDER BY p.name
    `).all(),
  };
}

// ---------- LIST ----------
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { status, assigned_to } = req.query;

  let sql = `
    SELECT t.*, u.name AS assigned_to_name, c.name AS created_by_name, bt.name AS batch_name,
      CASE WHEN t.scope_type = 'batch' THEN (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = t.batch_id AND e.status = 'active')
           WHEN t.scope_type = 'students' THEN (SELECT COUNT(*) FROM task_students ts2 WHERE ts2.task_id = t.id)
           ELSE NULL END AS total_students,
      CASE WHEN t.scope_type IN ('batch','students') THEN (
        SELECT COUNT(*) FROM task_students ts3 WHERE ts3.task_id = t.id AND ts3.status = 'done'
      ) ELSE NULL END AS done_students
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN batches bt ON bt.id = t.batch_id
  `;
  const conditions = [];
  const params = [];

  if (user.role !== 'admin') {
    conditions.push('t.assigned_to = ?');
    params.push(user.id);
  } else if (assigned_to) {
    conditions.push('t.assigned_to = ?');
    params.push(assigned_to);
  }

  if (status === 'pending') conditions.push("t.status = 'pending'");
  if (status === 'done') conditions.push("t.status = 'done'");

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY (t.status = \'done\'), t.due_date IS NULL, t.due_date ASC, t.created_at DESC';

  const tasks = await db.prepare(sql).all(...params);
  const staffList = user.role === 'admin' ? await db.prepare(`SELECT id, name FROM users WHERE active = 1 ORDER BY role, name`).all() : [];

  res.render('tasks_list', {
    user, tasks, staffList,
    filters: { status: status || '', assigned_to: assigned_to || '' },
    canManage: user.role === 'admin',
  });
});

// ---------- NEW ----------
router.get('/new', requireLogin, requireAdmin, async (req, res) => {
  const user = req.session.user;
  res.render('task_form', { user, ...(await taskFormLookups()), error: null, formValues: {} });
});

router.post('/', requireLogin, requireAdmin, async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  const lookups = await taskFormLookups();

  const rerenderWithError = (error) => res.render('task_form', { user, ...lookups, formValues: b, error });

  if (!b.title || !b.assigned_to || !b.scope_type) {
    return rerenderWithError('Title, assignee, and task type are all required.');
  }

  let batch_id = null;
  if (b.scope_type === 'batch') {
    batch_id = parseInt(b.batch_id, 10) || null;
    if (!batch_id || !lookups.batches.some(bt => bt.id === batch_id)) {
      return rerenderWithError('Select a batch for a batch-wide task.');
    }
  }

  const selectedEnrollmentIds = b.scope_type === 'students'
    ? [].concat(b.student_ids || []).map(id => parseInt(id, 10)).filter(Boolean)
    : [];

  if (b.scope_type === 'students' && selectedEnrollmentIds.length === 0) {
    return rerenderWithError('Select at least one student for a student-specific task.');
  }

  const result = await db.prepare(`
    INSERT INTO tasks (title, description, scope_type, batch_id, assigned_to, created_by, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.title, b.description || null, b.scope_type, batch_id,
    parseInt(b.assigned_to, 10), user.id, b.due_date || null
  );

  if (b.scope_type === 'students') {
    const insertEnrollment = db.prepare(`INSERT INTO task_students (task_id, enrollment_id) VALUES (?, ?)`);
    for (const eid of selectedEnrollmentIds) {
      await insertEnrollment.run(result.lastInsertRowid, eid);
    }
  }

  res.redirect('/tasks');
});

// ---------- DETAIL ----------
router.get('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const task = await db.prepare(`
    SELECT t.*, u.name AS assigned_to_name, c.name AS created_by_name, bt.name AS batch_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN batches bt ON bt.id = t.batch_id
    WHERE t.id = ?
  `).get(req.params.id);

  if (!task) return res.status(404).render('error', { message: 'Task not found.', user });
  if (!canAccessTask(user, task)) {
    return res.status(403).render('error', { message: 'This task is assigned to someone else.', user });
  }

  let studentRows = [];
  if (task.scope_type === 'batch') {
    studentRows = await db.prepare(`
      SELECT e.id, p.person_code AS student_code, p.name, e.course, bt.name AS batch_name,
        COALESCE(ts.status, 'pending') AS status, ts.completed_at, ts.notes
      FROM enrollments e
      JOIN persons p ON p.id = e.person_id
      LEFT JOIN batches bt ON bt.id = e.batch_id
      LEFT JOIN task_students ts ON ts.task_id = ? AND ts.enrollment_id = e.id
      WHERE e.batch_id = ? AND e.status = 'active'
      ORDER BY p.name
    `).all(task.id, task.batch_id);
  } else if (task.scope_type === 'students') {
    studentRows = await db.prepare(`
      SELECT e.id, p.person_code AS student_code, p.name, e.course, bt.name AS batch_name, ts.status, ts.completed_at, ts.notes
      FROM task_students ts
      JOIN enrollments e ON e.id = ts.enrollment_id
      JOIN persons p ON p.id = e.person_id
      LEFT JOIN batches bt ON bt.id = e.batch_id
      WHERE ts.task_id = ?
      ORDER BY p.name
    `).all(task.id);
  }

  res.render('task_detail', {
    user, task, studentRows,
    canAct: canAccessTask(user, task),
    canManage: user.role === 'admin',
  });
});

// ---------- COMPLETE (general scope: whole task) ----------
router.post('/:id/complete', requireLogin, async (req, res) => {
  const user = req.session.user;
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { message: 'Task not found.', user });
  if (!canAccessTask(user, task)) {
    return res.status(403).render('error', { message: 'This task is assigned to someone else.', user });
  }

  const newStatus = (req.body && req.body.mark) === 'undo' ? 'pending' : 'done';
  await db.prepare(`UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?`).run(
    newStatus, newStatus === 'done' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, task.id
  );

  res.redirect('/tasks/' + task.id);
});

// ---------- COMPLETE (per-student, for batch/students scope) ----------
router.post('/:id/students/:studentId/complete', requireLogin, async (req, res) => {
  const user = req.session.user;
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { message: 'Task not found.', user });
  if (!canAccessTask(user, task)) {
    return res.status(403).render('error', { message: 'This task is assigned to someone else.', user });
  }

  const newStatus = (req.body && req.body.mark) === 'undo' ? 'pending' : 'done';
  const completedAt = newStatus === 'done' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
  const notes = req.body && req.body.notes;

  const existing = await db.prepare('SELECT id FROM task_students WHERE task_id = ? AND enrollment_id = ?').get(task.id, req.params.studentId);
  if (existing) {
    await db.prepare('UPDATE task_students SET status = ?, completed_at = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run(newStatus, completedAt, notes, existing.id);
  } else {
    await db.prepare('INSERT INTO task_students (task_id, enrollment_id, status, completed_at, notes) VALUES (?, ?, ?, ?, ?)')
      .run(task.id, req.params.studentId, newStatus, completedAt, notes || null);
  }

  res.redirect('/tasks/' + task.id);
});

router.post('/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.redirect('/tasks');
});

module.exports = router;
