const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db/database');
const {
  requireLogin, requireViewStudents,
  canEditStudents, canEditFeeAllocated, canEditCourses,
  getFeePerms, isOwnScopeOnly,
} = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// One row per Person, with their enrollment count and a combined fee summary across
// ALL their enrollments (so the list gives a real "how much does this person owe in
// total" view, not just their most recent course).
const PERSON_LIST_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM enrollments e WHERE e.person_id = p.id) AS enrollment_count,
    (SELECT COUNT(*) FROM enrollments e WHERE e.person_id = p.id AND e.status = 'active') AS active_enrollment_count,
    (SELECT STRING_AGG(DISTINCT e.course, ', ') FROM enrollments e WHERE e.person_id = p.id) AS courses_summary,
    (SELECT COALESCE(SUM(e.total_fee), 0) FROM enrollments e WHERE e.person_id = p.id AND e.status = 'active') AS total_fee,
    (SELECT COALESCE(SUM(f.amount), 0) FROM fee_collections f JOIN enrollments e ON e.id = f.enrollment_id WHERE e.person_id = p.id AND e.status = 'active') AS fee_collected
  FROM persons p
`;

async function nextPersonCode() {
  const row = await db.prepare(`SELECT person_code FROM persons ORDER BY id DESC LIMIT 1`).get();
  let n = 1;
  if (row && row.person_code) {
    const match = row.person_code.match(/(\d+)$/);
    if (match) n = parseInt(match[1], 10) + 1;
  }
  return 'STU' + String(n).padStart(4, '0');
}

function showsSalesStaffPicker(user) {
  return user.role === 'admin' || user.role === 'staff';
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

// ---------- LIST ----------
router.get('/', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  let sql = PERSON_LIST_SELECT;
  const params = [];
  const conditions = [];

  if (isOwnScopeOnly(user)) {
    conditions.push('p.id IN (SELECT person_id FROM enrollments WHERE sales_staff_id = ?)');
    params.push(user.id);
  }

  const { q, batch_id, staff_id, course, status } = req.query;
  if (q) {
    conditions.push('(p.name ILIKE ? OR p.person_code ILIKE ? OR p.phone_call ILIKE ? OR p.phone_whatsapp ILIKE ? OR p.email ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (batch_id) {
    conditions.push('p.id IN (SELECT person_id FROM enrollments WHERE batch_id = ?)');
    params.push(batch_id);
  }
  if (course) {
    conditions.push('p.id IN (SELECT person_id FROM enrollments WHERE course = ?)');
    params.push(course);
  }
  if (staff_id && !isOwnScopeOnly(user)) {
    conditions.push('p.id IN (SELECT person_id FROM enrollments WHERE sales_staff_id = ?)');
    params.push(staff_id);
  }
  if (status === 'dropout') {
    conditions.push(`p.id IN (SELECT person_id FROM enrollments WHERE status = 'dropout')`);
  } else if (status === 'active') {
    conditions.push(`p.id IN (SELECT person_id FROM enrollments WHERE status = 'active')`);
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY p.created_at DESC';

  const persons = await db.prepare(sql).all(...params);
  const totals = persons.reduce((acc, p) => {
    acc.total_fee += p.total_fee || 0;
    acc.fee_collected += p.fee_collected || 0;
    acc.pending_fee += (p.total_fee || 0) - (p.fee_collected || 0);
    return acc;
  }, { total_fee: 0, fee_collected: 0, pending_fee: 0 });

  const batches = await allBatches();
  const staffList = isOwnScopeOnly(user) ? [] : await activeSalesStaffList();

  res.render('students_list', {
    user, students: persons, totals, batches, staffList, courses: await courseList(),
    filters: { q: q || '', batch_id: batch_id || '', staff_id: staff_id || '', course: course || '', status: status || '' },
    canEdit: canEditStudents(user),
    feePerms: getFeePerms(user),
  });
});

// ---------- EXPORT ----------
// One row per Enrollment (not per Person) so course-level fee detail isn't lost when
// someone has more than one course — the Person's Student ID repeats across their rows.
router.get('/export', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  let sql = `
    SELECT p.person_code, p.name, p.phone_whatsapp, p.phone_call, p.email, p.location, p.district,
           p.state, p.pincode, p.job_role, p.job_business_name, p.job_location,
           e.course, e.joined_date, e.total_fee, e.status,
           u.name AS sales_staff_name, bt.name AS batch_name, a.name AS added_by_name,
           COALESCE(f.total_collected, 0) AS fee_collected,
           (e.total_fee - COALESCE(f.total_collected, 0)) AS pending_fee
    FROM enrollments e
    JOIN persons p ON p.id = e.person_id
    LEFT JOIN users u ON u.id = e.sales_staff_id
    LEFT JOIN users a ON a.id = e.added_by
    LEFT JOIN batches bt ON bt.id = e.batch_id
    LEFT JOIN (SELECT enrollment_id, SUM(amount) AS total_collected FROM fee_collections GROUP BY enrollment_id) f ON f.enrollment_id = e.id
  `;
  const params = [];
  const conditions = [];
  if (isOwnScopeOnly(user)) { conditions.push('e.sales_staff_id = ?'); params.push(user.id); }
  const { q, batch_id, staff_id, course } = req.query;
  if (q) {
    conditions.push('(p.name ILIKE ? OR p.person_code ILIKE ? OR p.phone_call ILIKE ? OR p.phone_whatsapp ILIKE ? OR p.email ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (batch_id) { conditions.push('e.batch_id = ?'); params.push(batch_id); }
  if (course) { conditions.push('e.course = ?'); params.push(course); }
  if (staff_id && !isOwnScopeOnly(user)) { conditions.push('e.sales_staff_id = ?'); params.push(staff_id); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY p.created_at DESC, e.id';

  const rows = await db.prepare(sql).all(...params);
  const feePerms = getFeePerms(user);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  const columns = [
    { header: 'Student ID', key: 'person_code', width: 12 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Sales Team', key: 'sales_staff_name', width: 18 },
    { header: 'Phone (WhatsApp)', key: 'phone_whatsapp', width: 16 },
    { header: 'Phone (Call)', key: 'phone_call', width: 16 },
    { header: 'Mail ID', key: 'email', width: 22 },
    { header: 'Location', key: 'location', width: 16 },
    { header: 'District', key: 'district', width: 14 },
    { header: 'State', key: 'state', width: 14 },
    { header: 'Pincode', key: 'pincode', width: 10 },
    { header: 'Job Role', key: 'job_role', width: 16 },
    { header: 'Job/Business Name', key: 'job_business_name', width: 20 },
    { header: 'Job Location', key: 'job_location', width: 16 },
    { header: 'Batch', key: 'batch_name', width: 20 },
    { header: 'Course', key: 'course', width: 18 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Joined Date', key: 'joined_date', width: 12 },
  ];
  if (feePerms.viewAllocated) columns.push({ header: 'Total Fee', key: 'total_fee', width: 12 });
  if (feePerms.viewCollected) columns.push({ header: 'Fee Collected', key: 'fee_collected', width: 14 });
  if (feePerms.viewDue) columns.push({ header: 'Fee Pending', key: 'pending_fee', width: 14 });
  if (user.role === 'admin') columns.push({ header: 'Added By', key: 'added_by_name', width: 16 });

  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } };
  rows.forEach(r => sheet.addRow(r));
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="students-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---------- IMPORT ----------
// A row with a Student ID that matches an existing Person adds a NEW enrollment (course)
// to that person instead of creating a duplicate profile. A row with no match (or blank
// Student ID) creates a brand new Person + their first enrollment.
router.get('/import', requireLogin, requireViewStudents, (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to import students.', user });
  res.render('students_import', { user, result: null, error: null });
});

router.post('/import', requireLogin, requireViewStudents, upload.single('file'), async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to import students.', user });
  if (!req.file) return res.render('students_import', { user, result: null, error: 'Choose a .xlsx file to import.' });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch (e) {
    return res.render('students_import', { user, result: null, error: 'Could not read that file — make sure it\'s a .xlsx file exported from this dashboard (or matching its column layout).' });
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return res.render('students_import', { user, result: null, error: 'That file has no worksheet to read.' });

  const headerRow = sheet.getRow(1);
  const colIndex = {};
  headerRow.eachCell((cell, colNumber) => { colIndex[String(cell.value || '').trim().toLowerCase()] = colNumber; });

  const need = ['student id', 'name', 'sales team', 'joined date', 'course'];
  const missing = need.filter(k => !colIndex[k]);
  if (missing.length) {
    return res.render('students_import', { user, result: null, error: `The file is missing required column(s): ${missing.join(', ')}.` });
  }

  const salesStaffByName = {};
  (await db.prepare(`SELECT id, name FROM users WHERE role = 'sales_staff' AND active = 1`).all())
    .forEach(s => { salesStaffByName[s.name.trim().toLowerCase()] = s.id; });
  const batchByName = {};
  (await db.prepare(`SELECT id, name FROM batches`).all()).forEach(b => { batchByName[b.name.trim().toLowerCase()] = b.id; });
  const existingCourseNames = new Set((await db.prepare(`SELECT name FROM courses`).all()).map(r => r.name.toLowerCase()));
  const personByCode = {};
  (await db.prepare(`SELECT id, person_code FROM persons`).all()).forEach(p => { personByCode[p.person_code.toLowerCase()] = p.id; });

  const getCell = (row, key) => {
    const idx = colIndex[key];
    if (!idx) return '';
    const v = row.getCell(idx).value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object' && v.text) return String(v.text).trim();
    return String(v).trim();
  };

  let newPersons = 0, newEnrollments = 0, skipped = 0;
  const errors = [];

  const insertPerson = db.prepare(`
    INSERT INTO persons (person_code, name, phone_whatsapp, phone_call, email, location, district, state, pincode, job_role, job_business_name, job_location, added_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertEnrollment = db.prepare(`
    INSERT INTO enrollments (person_id, sales_staff_id, added_by, batch_id, course, joined_date, total_fee, remarks, status)
    VALUES (?,?,?,?,?,?,?,?, 'active')
  `);
  const canSetFee = canEditFeeAllocated(user);

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (row.cellCount === 0) continue;

    const name = getCell(row, 'name');
    const joinedDate = getCell(row, 'joined date');
    const salesTeamName = getCell(row, 'sales team');
    const studentCode = getCell(row, 'student id');

    if (!name && !joinedDate && !salesTeamName && !studentCode) continue;

    if (!joinedDate || !/^\d{4}-\d{2}-\d{2}$/.test(joinedDate)) { errors.push(`Row ${rowNumber}${name ? ' (' + name + ')' : ''}: Joined Date must be YYYY-MM-DD — skipped.`); skipped++; continue; }

    const course = getCell(row, 'course') || null;
    if (!course) { errors.push(`Row ${rowNumber} (${name}): Course is required — skipped.`); skipped++; continue; }
    if (!existingCourseNames.has(course.toLowerCase())) {
      if (canEditCourses(user)) {
        await db.prepare(`INSERT INTO courses (name, created_by) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`).run(course, user.id);
        existingCourseNames.add(course.toLowerCase());
      } else {
        errors.push(`Row ${rowNumber} (${name}): course "${course}" isn't on the list yet — saved anyway, but ask your Admin to add it so it shows up for others too.`);
      }
    }

    const salesStaffId = salesStaffByName[salesTeamName.toLowerCase()];
    if (!salesStaffId) { errors.push(`Row ${rowNumber} (${name}): Sales Team "${salesTeamName}" doesn't match an active account — skipped.`); skipped++; continue; }
    if (isOwnScopeOnly(user) && salesStaffId !== user.id) { errors.push(`Row ${rowNumber} (${name}): you can only import enrollments credited to yourself — skipped.`); skipped++; continue; }

    const batchName = getCell(row, 'batch');
    const batchId = batchName ? (batchByName[batchName.toLowerCase()] || null) : null;
    if (batchName && !batchId) errors.push(`Row ${rowNumber} (${name}): batch "${batchName}" not found — left unset.`);

    const totalFeeRaw = getCell(row, 'total fee');
    const totalFee = canSetFee ? (parseFloat(totalFeeRaw) || 0) : 0;
    const remarks = getCell(row, 'remarks') || null;

    let personId = studentCode ? personByCode[studentCode.toLowerCase()] : null;

    if (personId) {
      // Existing person -> this row becomes a NEW enrollment (another course) for them.
      if (isOwnScopeOnly(user)) {
        const owns = await db.prepare(`SELECT 1 FROM enrollments WHERE person_id = ? AND sales_staff_id = ?`).get(personId, user.id);
        if (!owns) { errors.push(`Row ${rowNumber} (${name}): student ${studentCode} isn't one of yours — skipped.`); skipped++; continue; }
      }
      await insertEnrollment.run(personId, salesStaffId, user.id, batchId, course, joinedDate, totalFee, remarks);
      newEnrollments++;
    } else {
      if (!name) { errors.push(`Row ${rowNumber}: missing Name — skipped.`); skipped++; continue; }
      const newCode = studentCode || await nextPersonCode();
      const personResult = await insertPerson.run(
        newCode, name,
        getCell(row, 'phone (whatsapp)') || null, getCell(row, 'phone (call)') || null, getCell(row, 'mail id') || null,
        getCell(row, 'location') || null, getCell(row, 'district') || null, getCell(row, 'state') || null, getCell(row, 'pincode') || null,
        getCell(row, 'job role') || null, getCell(row, 'job/business name') || null, getCell(row, 'job location') || null,
        user.id
      );
      personByCode[newCode.toLowerCase()] = personResult.lastInsertRowid;
      await insertEnrollment.run(personResult.lastInsertRowid, salesStaffId, user.id, batchId, course, joinedDate, totalFee, remarks);
      newPersons++;
      newEnrollments++;
    }
  }

  res.render('students_import', { user, error: null, result: { created: newPersons, updated: newEnrollments - newPersons, skipped, errors } });
});

// ---------- NEW PERSON (+ first enrollment) ----------
router.get('/new', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to add students.', user });
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  res.render('student_form', { user, isEdit: false, formValues: {}, personId: null, studentCode: null, staffList, batches: await allBatches(), courses: await courseList(), error: null, feePerms: getFeePerms(user) });
});

router.post('/', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to add students.', user });

  const b = req.body;
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  const batches = await allBatches();
  const courses = await courseList();

  const rerenderWithError = (error) => res.render('student_form', {
    user, isEdit: false, formValues: b, personId: null, studentCode: null, staffList, batches, courses, feePerms: getFeePerms(user), error,
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

  let batch_id = null;
  if (b.batch_id) {
    const candidate = parseInt(b.batch_id, 10);
    if (!candidate || !batches.some(bt => bt.id === candidate)) {
      return rerenderWithError('That batch no longer exists — pick a current one from the list, or leave it unset.');
    }
    batch_id = candidate;
  }

  await maybeCreateCourse(b, user);

  const person_code = await nextPersonCode();
  const total_fee = canEditFeeAllocated(user) ? (parseFloat(b.total_fee) || 0) : 0;

  const personResult = await db.prepare(`
    INSERT INTO persons (person_code, name, phone_whatsapp, phone_call, email, location, district, state, pincode, job_role, job_business_name, job_location, added_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    person_code, b.name, b.phone_whatsapp, b.phone_call, b.email,
    b.location, b.district, b.state, b.pincode, b.job_role, b.job_business_name, b.job_location, user.id
  );

  await db.prepare(`
    INSERT INTO enrollments (person_id, sales_staff_id, added_by, batch_id, course, joined_date, total_fee, remarks, status)
    VALUES (?,?,?,?,?,?,?,?, 'active')
  `).run(personResult.lastInsertRowid, sales_staff_id, user.id, batch_id, course, b.joined_date, total_fee, b.remarks);

  res.redirect('/students/' + personResult.lastInsertRowid);
});

// ---------- VIEW PERSON (profile + all their enrollments) ----------
router.get('/:id', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (!person) return res.status(404).render('error', { message: 'Student not found.', user });

  let enrollments = await db.prepare(`
    SELECT e.*, u.name AS sales_staff_name, bt.name AS batch_name,
      COALESCE(f.total_collected, 0) AS fee_collected,
      (e.total_fee - COALESCE(f.total_collected, 0)) AS pending_fee
    FROM enrollments e
    LEFT JOIN users u ON u.id = e.sales_staff_id
    LEFT JOIN batches bt ON bt.id = e.batch_id
    LEFT JOIN (SELECT enrollment_id, SUM(amount) AS total_collected FROM fee_collections GROUP BY enrollment_id) f ON f.enrollment_id = e.id
    WHERE e.person_id = ?
    ORDER BY e.created_at DESC
  `).all(person.id);

  if (isOwnScopeOnly(user)) {
    enrollments = enrollments.filter(e => e.sales_staff_id === user.id);
    if (enrollments.length === 0) {
      return res.status(403).render('error', { message: 'You can only view students assigned to you.', user });
    }
  }

  res.render('student_detail', {
    user, student: person, enrollments,
    canEditStudent: canEditStudents(user),
    feePerms: getFeePerms(user),
  });
});

router.get('/:id/edit', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to edit students.', user });
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (!person) return res.status(404).render('error', { message: 'Student not found.', user });
  if (isOwnScopeOnly(user)) {
    const owns = await db.prepare(`SELECT 1 FROM enrollments WHERE person_id = ? AND sales_staff_id = ?`).get(person.id, user.id);
    if (!owns) return res.status(403).render('error', { message: 'You can only edit students assigned to you.', user });
  }
  res.render('person_form', { user, person, error: null });
});

router.post('/:id', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  if (!canEditStudents(user)) return res.status(403).render('error', { message: 'You do not have permission to edit students.', user });
  const person = await db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.id);
  if (!person) return res.status(404).render('error', { message: 'Student not found.', user });
  if (isOwnScopeOnly(user)) {
    const owns = await db.prepare(`SELECT 1 FROM enrollments WHERE person_id = ? AND sales_staff_id = ?`).get(person.id, user.id);
    if (!owns) return res.status(403).render('error', { message: 'You can only edit students assigned to you.', user });
  }

  const b = req.body;
  if (!b.name) return res.render('person_form', { user, person: { ...person, ...b }, error: 'Name is required.' });

  await db.prepare(`
    UPDATE persons SET name = ?, phone_whatsapp = ?, phone_call = ?, email = ?, location = ?, district = ?, state = ?, pincode = ?,
      job_role = ?, job_business_name = ?, job_location = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `).run(b.name, b.phone_whatsapp, b.phone_call, b.email, b.location, b.district, b.state, b.pincode, b.job_role, b.job_business_name, b.job_location, person.id);

  res.redirect('/students/' + person.id);
});

router.post('/:id/delete', requireLogin, requireViewStudents, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'admin') return res.status(403).render('error', { message: 'Only admin can delete student records.', user });
  await db.prepare('DELETE FROM persons WHERE id = ?').run(req.params.id);
  res.redirect('/students');
});

module.exports = router;
