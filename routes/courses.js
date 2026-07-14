const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireEditCourses, canEditCourses, canEditStudents } = require('../middleware/auth');

// Viewable by anyone who might need to reference the list (i.e. can edit students);
// adding new courses is the part that's actually gated.
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user) && !canEditCourses(user)) {
    return res.status(403).render('error', { message: 'You do not have permission to view the course list.', user });
  }
  const courses = await db.prepare(`
    SELECT c.*, u.name AS created_by_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course = c.name) AS student_count
    FROM courses c
    LEFT JOIN users u ON u.id = c.created_by
    ORDER BY c.name
  `).all();
  res.render('courses_list', { user, courses, canManage: canEditCourses(user), error: null });
});

router.post('/', requireLogin, requireEditCourses, async (req, res) => {
  const user = req.session.user;
  const name = (req.body.name || '').trim();
  if (!name) {
    const courses = await db.prepare(`SELECT c.*, u.name AS created_by_name FROM courses c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.name`).all();
    return res.render('courses_list', { user, courses, canManage: true, error: 'Enter a course name.' });
  }
  await db.prepare(`INSERT INTO courses (name, created_by) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`).run(name, user.id);
  res.redirect('/courses');
});

router.post('/:id/delete', requireLogin, requireEditCourses, async (req, res) => {
  const user = req.session.user;
  const course = await db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).render('error', { message: 'Course not found.', user });
  const inUse = (await db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE course = ?').get(course.name)).c;
  if (inUse > 0) {
    return res.status(400).render('error', { message: `Cannot delete "${course.name}" — ${inUse} student(s) are recorded under it. Change their course first.`, user });
  }
  await db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  res.redirect('/courses');
});

module.exports = router;
