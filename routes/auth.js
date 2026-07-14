const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);

  if (!user || !bcrypt.compareSync(password || '', user.password)) {
    return res.render('login', { error: 'Invalid username or password.' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    designation: user.designation,
    perm_view_students: user.perm_view_students,
    perm_edit_students: user.perm_edit_students,
    perm_view_fee_allocated: user.perm_view_fee_allocated,
    perm_edit_fee_allocated: user.perm_edit_fee_allocated,
    perm_view_fee_collected: user.perm_view_fee_collected,
    perm_edit_fee_collected: user.perm_edit_fee_collected,
    perm_view_fee_due: user.perm_view_fee_due,
    perm_view_fee_ageing: user.perm_view_fee_ageing,
    perm_view_fee_due_percentage: user.perm_view_fee_due_percentage,
    perm_view_batches: user.perm_view_batches,
    perm_edit_batches: user.perm_edit_batches,
    perm_edit_courses: user.perm_edit_courses,
    perm_view_invoices: user.perm_view_invoices,
    perm_edit_invoices: user.perm_edit_invoices,
  };
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('change_password', { error: null, success: null, user: req.session.user });
});

router.post('/change-password', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { current_password, new_password, confirm_password } = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  if (!bcrypt.compareSync(current_password || '', user.password)) {
    return res.render('change_password', { error: 'Current password is incorrect.', success: null, user: req.session.user });
  }
  if (!new_password || new_password.length < 4) {
    return res.render('change_password', { error: 'New password must be at least 4 characters.', success: null, user: req.session.user });
  }
  if (new_password !== confirm_password) {
    return res.render('change_password', { error: 'New password and confirmation do not match.', success: null, user: req.session.user });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  res.render('change_password', { error: null, success: 'Password updated successfully.', user: req.session.user });
});

module.exports = router;
