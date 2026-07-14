const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireLogin, requireAdmin } = require('../middleware/auth');

// Fields captured from the checkbox grid in the Staff & Access form
const PERM_FIELDS = [
  'perm_view_students', 'perm_edit_students',
  'perm_view_fee_allocated', 'perm_edit_fee_allocated',
  'perm_view_fee_collected', 'perm_edit_fee_collected',
  'perm_view_fee_due', 'perm_view_fee_ageing', 'perm_view_fee_due_percentage',
  'perm_view_batches', 'perm_edit_batches', 'perm_edit_courses',
  'perm_view_invoices', 'perm_edit_invoices',
];

function permValues(body) {
  return PERM_FIELDS.map(f => (body[f] ? 1 : 0));
}

router.get('/', requireLogin, requireAdmin, async (req, res) => {
  const users = await db.prepare('SELECT * FROM users ORDER BY role, name').all();
  const facultyBatches = await db.prepare(`SELECT faculty_id, STRING_AGG(name, ', ') AS batch_names FROM batches WHERE faculty_id IS NOT NULL GROUP BY faculty_id`).all();
  const batchesByFaculty = {};
  facultyBatches.forEach(row => { batchesByFaculty[row.faculty_id] = row.batch_names; });
  users.forEach(u => { u.assignedBatches = batchesByFaculty[u.id] || null; });
  res.render('users_list', { user: req.session.user, users, error: null });
});

router.get('/new', requireLogin, requireAdmin, (req, res) => {
  res.render('user_form', { user: req.session.user, staffUser: null, error: null });
});

router.post('/', requireLogin, requireAdmin, async (req, res) => {
  const { username, password, name, role, designation } = req.body;

  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.render('user_form', { user: req.session.user, staffUser: null, error: 'Username already exists.' });
  }

  const hash = bcrypt.hashSync(password || 'changeme123', 10);

  // sales_staff role always has full rights over their own records (enforced in middleware);
  // staff role uses the checkbox permissions from the form.
  await db.prepare(`
    INSERT INTO users (
      username, password, name, role, designation,
      ${PERM_FIELDS.join(', ')}
    ) VALUES (?,?,?,?,?, ${PERM_FIELDS.map(() => '?').join(',')})
  `).run(username, hash, name, role, designation || null, ...permValues(req.body));

  res.redirect('/users');
});

router.get('/:id/edit', requireLogin, requireAdmin, async (req, res) => {
  const staffUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!staffUser) return res.status(404).render('error', { message: 'User not found.', user: req.session.user });
  res.render('user_form', { user: req.session.user, staffUser, error: null });
});

router.post('/:id', requireLogin, requireAdmin, async (req, res) => {
  const { name, role, designation, new_password, active } = req.body;

  await db.prepare(`
    UPDATE users SET name = ?, role = ?, designation = ?, active = ?,
      ${PERM_FIELDS.map(f => `${f} = ?`).join(', ')}
    WHERE id = ?
  `).run(name, role, designation || null, active ? 1 : 0, ...permValues(req.body), req.params.id);

  if (new_password && new_password.trim().length >= 4) {
    const hash = bcrypt.hashSync(new_password.trim(), 10);
    await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
  }

  res.redirect('/users');
});

router.post('/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.user.id) {
    return res.status(400).render('error', { message: 'You cannot delete your own account while logged in.', user: req.session.user });
  }
  const studentCount = (await db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE sales_staff_id = ?').get(req.params.id)).c;
  if (studentCount > 0) {
    return res.status(400).render('error', { message: `Cannot delete this staff member — ${studentCount} enrollment(s) are still assigned to them. Reassign those first, or deactivate this account instead.`, user: req.session.user });
  }
  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/users');
});

module.exports = router;
