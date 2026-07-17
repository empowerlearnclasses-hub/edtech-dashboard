const express = require('express');
const router = express.Router();
const db = require('../db/database');
const {
  requireLogin, canEditStudents, canEditFeeAllocated, canEditFeeCollected,
  canEditCourses, canEditFees, isOwnScopeOnly, getFeePerms,
  canViewInvoicesForStudent, canCreateInvoicesForStudent,
} = require('../middleware/auth');

const ENROLLMENT_SELECT = `
  SELECT e.*, p.person_code, p.name AS person_name, p.phone_call, p.phone_whatsapp, p.email,
         u.name AS sales_staff_name,
         a.name AS added_by_name,
         COALESCE(f.total_collected, 0) AS fee_collected,
         (e.total_fee - COALESCE(f.total_collected, 0)) AS pending_fee
  FROM enrollments e
  JOIN persons p ON p.id = e.person_id
  LEFT JOIN users u ON u.id = e.sales_staff_id
  LEFT JOIN users a ON a.id = e.added_by
  LEFT JOIN (
    SELECT enrollment_id, SUM(amount) AS total_collected FROM fee_collections GROUP BY enrollment_id
  ) f ON f.enrollment_id = e.id
`;

async function getEnrollment(id) {
  const enrollment = await db.prepare(ENROLLMENT_SELECT + ' WHERE e.id = ?').get(id);
  if (enrollment) enrollment.batches = await getEnrollmentBatches(id);
  return enrollment;
}

// A student can be scheduled into more than one batch for the same course (e.g. morning
// + evening sessions) — this returns all of them for one enrollment.
async function getEnrollmentBatches(enrollmentId) {
  return db.prepare(`
    SELECT b.id, b.name FROM enrollment_batches eb JOIN batches b ON b.id = eb.batch_id
    WHERE eb.enrollment_id = ? ORDER BY b.name
  `).all(enrollmentId);
}

// Replaces the full set of batches linked to an enrollment with exactly the given list —
// simplest correct way to handle "add some, remove some" in one form submission.
async function setEnrollmentBatches(enrollmentId, batchIds) {
  await db.prepare('DELETE FROM enrollment_batches WHERE enrollment_id = ?').run(enrollmentId);
  const insert = db.prepare('INSERT INTO enrollment_batches (enrollment_id, batch_id) VALUES (?, ?) ON CONFLICT (enrollment_id, batch_id) DO NOTHING');
  for (const batchId of batchIds) {
    await insert.run(enrollmentId, batchId);
  }
}

async function activeSalesStaffList() {
  return db.prepare(`SELECT id, name FROM users WHERE role = 'sales_staff' AND active = 1 ORDER BY name`).all();
}
async function allBatches() {
  return db.prepare(`SELECT id, name FROM batches ORDER BY start_date DESC, name`).all();
}
async function courseList() {
  return (await db.prepare(`SELECT name FROM courses ORDER BY name`).all()).map(r => r.name);
}
function showsSalesStaffPicker(user) {
  return user.role === 'admin' || user.role === 'staff';
}
function getCourseValue(b) {
  if (b.course_select === '__other__') return (b.course_other || '').trim() || null;
  return (b.course_select || '').trim() || null;
}
async function maybeCreateCourse(b, user) {
  if (b.course_select === '__other__') {
    const custom = (b.course_other || '').trim();
    if (custom && canEditCourses(user)) {
      await db.prepare(`INSERT INTO courses (name, created_by) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`).run(custom, user.id);
    }
  }
}
// Validates the submitted batch_ids[] against the current batch list, so a stale form
// (referencing a since-deleted batch) is rejected with a clear error rather than silently
// dropped or crashing.
function parseSelectedBatchIds(b, batches) {
  const submitted = [].concat(b.batch_ids || []).map(id => parseInt(id, 10)).filter(Boolean);
  const valid = submitted.filter(id => batches.some(bt => bt.id === id));
  return { valid, hadInvalid: valid.length !== submitted.length };
}

// ---------- NEW ENROLLMENT for an existing Person (a second/third course) ----------
router.get('/students/:personId/enrollments/new', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to add enrollments.', user });
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.personId);
  if (!person) return res.status(404).render('error', { message: 'Student not found.', user });
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  // Arriving from "Convert to Admission" on a Lead pre-fills the course already known.
  const { lead_id, course } = req.query;
  res.render('enrollment_form', {
    user, person, isEdit: false, enrollment: { batches: [], course: course || null, lead_id: lead_id || null },
    staffList, batches: await allBatches(), courses: await courseList(),
    feePerms: getFeePerms(user), error: null,
  });
});

router.post('/students/:personId/enrollments', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to add enrollments.', user });
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.personId);
  if (!person) return res.status(404).render('error', { message: 'Student not found.', user });

  const b = req.body;
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  const batches = await allBatches();
  const courses = await courseList();

  const rerenderWithError = (error) => res.render('enrollment_form', {
    user, person, isEdit: false, enrollment: { ...b, batches: [] }, staffList, batches, courses, feePerms: getFeePerms(user), error,
  });

  if (!b.joined_date) return rerenderWithError('Joined Date is required.');
  const course = getCourseValue(b);
  if (!course) return rerenderWithError(b.course_select === '__other__' ? 'Type the course name, or pick one from the list.' : 'Course is required.');

  let sales_staff_id;
  if (user.role === 'sales_staff') {
    sales_staff_id = user.id;
  } else {
    sales_staff_id = parseInt(b.sales_staff_id, 10) || null;
    if (!sales_staff_id || !staffList.some(s => s.id === sales_staff_id)) {
      return rerenderWithError('Select which Sales Team member this admission should be credited to.');
    }
  }

  const { valid: batchIds, hadInvalid } = parseSelectedBatchIds(b, batches);
  if (hadInvalid) return rerenderWithError('One of the selected batches no longer exists — pick current ones from the list.');

  await maybeCreateCourse(b, user);
  const total_fee = canEditFeeAllocated(user) ? (parseFloat(b.total_fee) || 0) : 0;

  const result = await db.prepare(`
    INSERT INTO enrollments (person_id, sales_staff_id, added_by, course, joined_date, total_fee, remarks, status)
    VALUES (?,?,?,?,?,?,?, 'active')
  `).run(person.id, sales_staff_id, user.id, course, b.joined_date, total_fee, b.remarks || null);

  await setEnrollmentBatches(result.lastInsertRowid, batchIds);

  // Closes the loop with the Lead this admission came from, if any.
  if (b.lead_id) {
    await db.prepare(`UPDATE leads SET status = 'Joined', converted_enrollment_id = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
      .run(result.lastInsertRowid, b.lead_id);
  }

  res.redirect('/students/' + person.id);
});

// ---------- VIEW ----------
router.get('/enrollments/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const enrollment = await getEnrollment(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  if (isOwnScopeOnly(user) && enrollment.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only view enrollments assigned to you.', user });
  }

  const feeHistory = await db.prepare(`
    SELECT f.*, u.name AS collected_by_name,
      (SELECT id FROM receipt_vouchers rv WHERE rv.fee_collection_id = f.id) AS receipt_id
    FROM fee_collections f LEFT JOIN users u ON u.id = f.collected_by
    WHERE f.enrollment_id = ? ORDER BY f.collection_date DESC, f.id DESC
  `).all(enrollment.id);

  const invoices = await db.prepare(`SELECT * FROM invoices WHERE enrollment_id = ? ORDER BY issue_date DESC, id DESC`).all(enrollment.id);
  const feePerms = getFeePerms(user);

  if (enrollment.joined_date) {
    const joined = new Date(enrollment.joined_date);
    enrollment.due_days = Math.max(0, Math.floor((new Date() - joined) / (1000 * 60 * 60 * 24)));
  } else {
    enrollment.due_days = null;
  }
  enrollment.due_percentage = enrollment.total_fee > 0
    ? Math.round((enrollment.pending_fee / enrollment.total_fee) * 1000) / 10
    : 0;

  res.render('enrollment_detail', {
    user, enrollment, feeHistory, invoices,
    canEditEnrollment: canEditStudents(user),
    canEditFee: canEditFees(user),
    canViewFee: feePerms.viewAllocated || feePerms.viewCollected || feePerms.viewDue || feePerms.viewAgeing || feePerms.viewDuePercentage,
    feePerms,
    canViewInvoices: canViewInvoicesForStudent(user, enrollment),
    canCreateInvoices: canCreateInvoicesForStudent(user, enrollment),
  });
});

// ---------- EDIT ----------
router.get('/enrollments/:id/edit', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to edit enrollments.', user });
  const enrollment = await getEnrollment(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  if (isOwnScopeOnly(user) && enrollment.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only edit enrollments assigned to you.', user });
  }
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(enrollment.person_id);
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  res.render('enrollment_form', {
    user, person, isEdit: true, enrollment, staffList, batches: await allBatches(), courses: await courseList(),
    feePerms: getFeePerms(user), error: null,
  });
});

router.post('/enrollments/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to edit enrollments.', user });
  const enrollment = await getEnrollment(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  if (isOwnScopeOnly(user) && enrollment.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only edit enrollments assigned to you.', user });
  }

  const b = req.body;
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(enrollment.person_id);
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  const batches = await allBatches();
  const courses = await courseList();

  const rerenderWithError = (error) => {
    const submittedBatchIds = [].concat(b.batch_ids || []).map(id => parseInt(id, 10)).filter(Boolean);
    return res.render('enrollment_form', {
      user, person, isEdit: true,
      enrollment: { ...enrollment, ...b, batches: submittedBatchIds.map(id => ({ id })) },
      staffList, batches, courses, feePerms: getFeePerms(user), error,
    });
  };

  if (!b.joined_date) return rerenderWithError('Joined Date is required.');
  const course = getCourseValue(b);
  if (!course) return rerenderWithError(b.course_select === '__other__' ? 'Type the course name, or pick one from the list.' : 'Course is required.');

  let sales_staff_id = enrollment.sales_staff_id;
  if (showsSalesStaffPicker(user) && b.sales_staff_id) {
    const candidate = parseInt(b.sales_staff_id, 10);
    if (!candidate || !staffList.some(s => s.id === candidate)) return rerenderWithError('Select a valid Sales Team member for this admission.');
    sales_staff_id = candidate;
  }

  const { valid: batchIds, hadInvalid } = parseSelectedBatchIds(b, batches);
  if (hadInvalid) return rerenderWithError('One of the selected batches no longer exists — pick current ones from the list.');

  await maybeCreateCourse(b, user);
  const total_fee = canEditFeeAllocated(user) ? (parseFloat(b.total_fee) || 0) : enrollment.total_fee;
  const status = (user.role === 'admin' || user.role === 'staff') && ['active', 'dropout'].includes(b.status) ? b.status : enrollment.status;

  await db.prepare(`
    UPDATE enrollments SET sales_staff_id = ?, course = ?, joined_date = ?, total_fee = ?, remarks = ?, status = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `).run(sales_staff_id, course, b.joined_date, total_fee, b.remarks || null, status, enrollment.id);

  await setEnrollmentBatches(enrollment.id, batchIds);

  res.redirect('/enrollments/' + enrollment.id);
});

// Quick status toggle (Active <-> Dropout) without going through the full edit form.
router.post('/enrollments/:id/status', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user) || (user.role !== 'admin' && user.role !== 'staff')) {
    return res.status(403).render('error', { message: 'You do not have permission to change enrollment status.', user });
  }
  const enrollment = await db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  const status = req.body.status === 'dropout' ? 'dropout' : 'active';
  await db.prepare(`UPDATE enrollments SET status = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`).run(status, enrollment.id);
  res.redirect('/enrollments/' + enrollment.id);
});

router.post('/enrollments/:id/delete', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'admin') return res.status(403).render('error', { message: 'Only admin can delete an enrollment record.', user });
  const enrollment = await db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  const personId = enrollment.person_id;
  await db.prepare('DELETE FROM enrollments WHERE id = ?').run(enrollment.id);
  res.redirect('/students/' + personId);
});

// ---------- FEE COLLECTION ENTRY ----------
router.post('/enrollments/:id/fees', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (!canEditFeeCollected(user)) return res.status(403).render('error', { message: 'You do not have permission to record fee collections.', user });
  const enrollment = await db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  if (isOwnScopeOnly(user) && enrollment.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only collect fees for enrollments assigned to you.', user });
  }

  const { amount, collection_date, notes } = req.body;
  await db.prepare(`INSERT INTO fee_collections (enrollment_id, amount, collection_date, collected_by, notes) VALUES (?, ?, ?, ?, ?)`)
    .run(enrollment.id, parseFloat(amount) || 0, collection_date, user.id, notes);

  res.redirect('/enrollments/' + enrollment.id);
});

router.post('/enrollments/:id/fees/:feeId/delete', requireLogin, async (req, res) => {
  const user = req.session.user;
  const enrollment = await db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
  if (!enrollment) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  const allowed = user.role === 'admin'
    || (user.role === 'sales_staff' && enrollment.sales_staff_id === user.id)
    || (user.role === 'staff' && canEditFeeCollected(user));
  if (!allowed) return res.status(403).render('error', { message: 'You do not have permission to remove this fee entry.', user });
  await db.prepare('DELETE FROM fee_collections WHERE id = ? AND enrollment_id = ?').run(req.params.feeId, req.params.id);
  res.redirect('/enrollments/' + req.params.id);
});

module.exports = router;
module.exports.ENROLLMENT_SELECT = ENROLLMENT_SELECT;
module.exports.getEnrollment = getEnrollment;
module.exports.getEnrollmentBatches = getEnrollmentBatches;
