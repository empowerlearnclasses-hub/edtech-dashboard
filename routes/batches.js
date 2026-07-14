const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireEditBatches, canViewBatches, canEditBatches } = require('../middleware/auth');

function pad2(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

async function facultyList() {
  return db.prepare(`SELECT id, name, role, designation FROM users WHERE role = 'faculty' AND active = 1 ORDER BY name`).all();
}

// canViewBatches(user) is a BROAD grant (Admin, or Staff/Sales Staff explicitly given
// view access under Staff & Access). Faculty is narrower and separate: being set as the
// Faculty on a batch lets you see that one batch's calendar even without broad access.
function isFacultyOn(batch, user) {
  return !!(batch && user && batch.faculty_id === user.id);
}

// ---------- LIST ----------
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const broadView = canViewBatches(user);

  let batches;
  if (broadView) {
    batches = await db.prepare(`
      SELECT b.*, f.name AS faculty_account_name,
        (SELECT COUNT(*) FROM enrollments e2 WHERE e2.batch_id = b.id AND e2.status = 'active') AS student_count,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.status = 'working') AS working_days,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.status = 'leave') AS leave_days,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.status = 'holiday') AS holiday_days,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.class_completed = 1) AS classes_completed,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.class_completed = 1 AND bs.recording_uploaded = 1) AS recordings_uploaded,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.class_completed = 1 AND bs.recording_uploaded = 0) AS recordings_pending
      FROM batches b
      LEFT JOIN users f ON f.id = b.faculty_id
      ORDER BY b.start_date DESC, b.name
    `).all();
  } else {
    // No broad grant — fall back to "batches where I'm the assigned Faculty" only.
    batches = await db.prepare(`
      SELECT b.*, f.name AS faculty_account_name,
        (SELECT COUNT(*) FROM enrollments e2 WHERE e2.batch_id = b.id AND e2.status = 'active') AS student_count,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.status = 'working') AS working_days,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.status = 'leave') AS leave_days,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.status = 'holiday') AS holiday_days,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.class_completed = 1) AS classes_completed,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.class_completed = 1 AND bs.recording_uploaded = 1) AS recordings_uploaded,
        (SELECT COUNT(*) FROM batch_sessions bs WHERE bs.batch_id = b.id AND bs.class_completed = 1 AND bs.recording_uploaded = 0) AS recordings_pending
      FROM batches b
      LEFT JOIN users f ON f.id = b.faculty_id
      WHERE b.faculty_id = ?
      ORDER BY b.start_date DESC, b.name
    `).all(user.id);

    if (batches.length === 0) {
      return res.status(403).render('error', { message: 'You do not have permission to view batch calendars, and no batch currently has you set as Faculty. Ask your Admin to grant Batch access under Staff & Access, or assign you as Faculty on a batch.', user });
    }
  }

  res.render('batches_list', { user, batches, canManage: canEditBatches(user), facultyScoped: !broadView });
});

// ---------- NEW ----------
router.get('/new', requireLogin, requireEditBatches, async (req, res) => {
  res.render('batch_form', { user: req.session.user, formValues: {}, isEdit: false, faculty: await facultyList(), error: null });
});

router.post('/', requireLogin, requireEditBatches, async (req, res) => {
  const user = req.session.user;
  const b = req.body;
  const faculty = await facultyList();

  const rerenderWithError = (error) => res.render('batch_form', { user, formValues: b, isEdit: false, faculty, error });

  if (!b.name || !b.start_date || !b.end_date) {
    return rerenderWithError('Batch name, start date, and end date are all required.');
  }
  if (b.end_date < b.start_date) {
    return rerenderWithError('End date cannot be before the start date.');
  }

  const existing = await db.prepare('SELECT id FROM batches WHERE name = ?').get(b.name);
  if (existing) {
    return rerenderWithError('A batch with this name already exists.');
  }

  let faculty_id = null;
  if (b.faculty_id) {
    const candidate = parseInt(b.faculty_id, 10);
    if (candidate && faculty.some(f => f.id === candidate)) faculty_id = candidate;
  }

  const result = await db.prepare(`
    INSERT INTO batches (name, start_date, end_date, faculty_id, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(b.name, b.start_date, b.end_date, faculty_id, b.notes || null, user.id);

  // Pre-populate a session row for every day in range, defaulted to "working" — this is
  // what lets the calendar simply mark specific days as Leave/Holiday rather than the other way round.
  const insertSession = db.prepare(`INSERT INTO batch_sessions (batch_id, session_date, status) VALUES (?, ?, 'working') ON CONFLICT (batch_id, session_date) DO NOTHING`);
  const start = new Date(b.start_date);
  const end = new Date(b.end_date);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    await insertSession.run(result.lastInsertRowid, toISODate(d));
  }

  res.redirect('/batches/' + result.lastInsertRowid);
});

// ---------- EDIT (name/faculty/notes/date-range extension) ----------
router.get('/:id/edit', requireLogin, requireEditBatches, async (req, res) => {
  const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user: req.session.user });
  res.render('batch_form', { user: req.session.user, formValues: batch, isEdit: true, faculty: await facultyList(), error: null });
});

router.post('/:id', requireLogin, requireEditBatches, async (req, res) => {
  const user = req.session.user;
  const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user });

  const b = req.body;
  const faculty = await facultyList();
  const rerenderWithError = (error) => res.render('batch_form', { user, formValues: { ...batch, ...b }, isEdit: true, faculty, error });

  if (!b.name || !b.start_date || !b.end_date) {
    return rerenderWithError('Batch name, start date, and end date are all required.');
  }
  if (b.end_date < b.start_date) {
    return rerenderWithError('End date cannot be before the start date.');
  }

  const duplicate = await db.prepare('SELECT id FROM batches WHERE name = ? AND id != ?').get(b.name, batch.id);
  if (duplicate) {
    return rerenderWithError('A batch with this name already exists.');
  }

  let faculty_id = null;
  if (b.faculty_id) {
    const candidate = parseInt(b.faculty_id, 10);
    if (candidate && faculty.some(f => f.id === candidate)) faculty_id = candidate;
  }

  await db.prepare(`UPDATE batches SET name = ?, start_date = ?, end_date = ?, faculty_id = ?, notes = ? WHERE id = ?`)
    .run(b.name, b.start_date, b.end_date, faculty_id, b.notes || null, batch.id);

  // If the range was extended, fill in session rows for any newly-covered days.
  // Existing days (and anything already marked Leave/Holiday / given a Zoom link) are left untouched.
  const insertSession = db.prepare(`INSERT INTO batch_sessions (batch_id, session_date, status) VALUES (?, ?, 'working') ON CONFLICT (batch_id, session_date) DO NOTHING`);
  const start = new Date(b.start_date);
  const end = new Date(b.end_date);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    await insertSession.run(batch.id, toISODate(d));
  }

  res.redirect('/batches/' + batch.id);
});

router.post('/:id/delete', requireLogin, requireEditBatches, async (req, res) => {
  const inUse = (await db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE batch_id = ?').get(req.params.id)).c;
  if (inUse > 0) {
    return res.status(400).render('error', { message: `Cannot delete this batch — ${inUse} student(s) are still assigned to it. Move them to a different batch first.`, user: req.session.user });
  }
  await db.prepare('DELETE FROM batches WHERE id = ?').run(req.params.id);
  res.redirect('/batches');
});

// ---------- CALENDAR ----------
router.get('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const batch = await db.prepare(`
    SELECT b.*, f.name AS faculty_account_name
    FROM batches b LEFT JOIN users f ON f.id = b.faculty_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user });

  const broadView = canViewBatches(user);
  const isFaculty = isFacultyOn(batch, user);
  if (!broadView && !isFaculty) {
    return res.status(403).render('error', { message: 'You do not have permission to view this batch calendar.', user });
  }

  // Which month to show: query param, else the batch's start month, else today.
  let monthParam = req.query.month;
  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    monthParam = (batch.start_date || toISODate(new Date())).slice(0, 7);
  }
  const [viewYear, viewMonth] = monthParam.split('-').map(Number); // viewMonth is 1-12

  const firstOfMonth = new Date(viewYear, viewMonth - 1, 1);
  const lastOfMonth = new Date(viewYear, viewMonth, 0);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay()); // back up to Sunday
  const gridEnd = new Date(lastOfMonth);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay())); // forward to Saturday

  const sessions = await db.prepare(`SELECT * FROM batch_sessions WHERE batch_id = ? AND session_date BETWEEN ? AND ?`)
    .all(batch.id, toISODate(gridStart), toISODate(gridEnd));
  const sessionByDate = {};
  sessions.forEach(s => { sessionByDate[s.session_date] = s; });

  const weeks = [];
  let cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const iso = toISODate(cursor);
      week.push({
        date: iso,
        day: cursor.getDate(),
        inMonth: cursor.getMonth() === viewMonth - 1,
        inRange: batch.start_date && batch.end_date && iso >= batch.start_date && iso <= batch.end_date,
        session: sessionByDate[iso] || null,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const prevMonthDate = new Date(viewYear, viewMonth - 2, 1);
  const nextMonthDate = new Date(viewYear, viewMonth, 1);
  const monthLabel = firstOfMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const studentCount = (await db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE batch_id = ?').get(batch.id)).c;

  const classStats = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN class_completed = 1 THEN 1 ELSE 0 END), 0) AS classes_completed,
      COALESCE(SUM(CASE WHEN class_completed = 1 AND recording_uploaded = 1 THEN 1 ELSE 0 END), 0) AS recordings_uploaded,
      COALESCE(SUM(CASE WHEN class_completed = 1 AND recording_uploaded = 0 THEN 1 ELSE 0 END), 0) AS recordings_pending,
      COALESCE(SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END), 0) AS total_working_days
    FROM batch_sessions WHERE batch_id = ?
  `).get(batch.id);

  res.render('batch_calendar', {
    user, batch, weeks, monthLabel, studentCount, classStats,
    prevMonth: `${prevMonthDate.getFullYear()}-${pad2(prevMonthDate.getMonth() + 1)}`,
    nextMonth: `${nextMonthDate.getFullYear()}-${pad2(nextMonthDate.getMonth() + 1)}`,
    canManage: canEditBatches(user),
    canMarkStatus: canEditBatches(user),
    todayISO: toISODate(new Date()),
  });
});

// ---------- SESSION EDIT (single day: working/leave/holiday, Zoom link, notes) ----------
router.get('/:id/sessions/:date/edit', requireLogin, requireEditBatches, async (req, res) => {
  const user = req.session.user;
  const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user });
  const session = await db.prepare('SELECT * FROM batch_sessions WHERE batch_id = ? AND session_date = ?').get(batch.id, req.params.date);
  res.render('batch_session_form', {
    user, batch, date: req.params.date,
    session: session || { status: 'working', zoom_link: '', notes: '' },
  });
});

router.post('/:id/sessions/:date', requireLogin, requireEditBatches, async (req, res) => {
  const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user: req.session.user });

  const b = req.body;
  const status = ['leave', 'holiday'].includes(b.status) ? b.status : 'working';
  // A Leave/Holiday day has no class, so it can't have a Zoom link — enforced here too,
  // not just by disabling the field client-side, in case of a direct form submission.
  const zoom_link = status === 'working' ? (b.zoom_link || null) : null;

  const existing = await db.prepare('SELECT id FROM batch_sessions WHERE batch_id = ? AND session_date = ?').get(batch.id, req.params.date);
  if (existing) {
    await db.prepare('UPDATE batch_sessions SET status = ?, zoom_link = ?, notes = ? WHERE id = ?')
      .run(status, zoom_link, b.notes || null, existing.id);
  } else {
    await db.prepare('INSERT INTO batch_sessions (batch_id, session_date, status, zoom_link, notes) VALUES (?, ?, ?, ?, ?)')
      .run(batch.id, req.params.date, status, zoom_link, b.notes || null);
  }

  res.redirect(`/batches/${batch.id}?month=${req.params.date.slice(0, 7)}`);
});

// ---------- CLASS STATUS (narrower than full edit — assigned Faculty can do this too) ----------
router.post('/:id/sessions/:date/class-status', requireLogin, async (req, res) => {
  const user = req.session.user;
  const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user });
  if (!canEditBatches(user)) {
    return res.status(403).render('error', { message: 'You do not have permission to update class status for this batch.', user });
  }

  const completed = (req.body && req.body.mark) === 'undo' ? 0 : 1;
  const existing = await db.prepare('SELECT id FROM batch_sessions WHERE batch_id = ? AND session_date = ?').get(batch.id, req.params.date);
  if (existing) {
    // Un-completing a class also clears "recording uploaded" — a recording can't be
    // uploaded for a class that's no longer marked as having happened.
    await db.prepare('UPDATE batch_sessions SET class_completed = ?, recording_uploaded = CASE WHEN ? = 0 THEN 0 ELSE recording_uploaded END WHERE id = ?')
      .run(completed, completed, existing.id);
  } else {
    await db.prepare('INSERT INTO batch_sessions (batch_id, session_date, status, class_completed) VALUES (?, ?, \'working\', ?)')
      .run(batch.id, req.params.date, completed);
  }

  res.redirect(`/batches/${batch.id}?month=${req.params.date.slice(0, 7)}`);
});

router.post('/:id/sessions/:date/recording-status', requireLogin, async (req, res) => {
  const user = req.session.user;
  const batch = await db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).render('error', { message: 'Batch not found.', user });
  if (!canEditBatches(user)) {
    return res.status(403).render('error', { message: 'You do not have permission to update recording status for this batch.', user });
  }

  const uploaded = (req.body && req.body.mark) === 'undo' ? 0 : 1;
  const existing = await db.prepare('SELECT id FROM batch_sessions WHERE batch_id = ? AND session_date = ?').get(batch.id, req.params.date);
  if (existing) {
    // A recording can only be "uploaded" for a class that actually happened.
    await db.prepare('UPDATE batch_sessions SET recording_uploaded = ?, class_completed = CASE WHEN ? = 1 THEN 1 ELSE class_completed END WHERE id = ?')
      .run(uploaded, uploaded, existing.id);
  } else if (uploaded) {
    await db.prepare('INSERT INTO batch_sessions (batch_id, session_date, status, class_completed, recording_uploaded) VALUES (?, ?, \'working\', 1, 1)')
      .run(batch.id, req.params.date);
  }

  res.redirect(`/batches/${batch.id}?month=${req.params.date.slice(0, 7)}`);
});

module.exports = router;
