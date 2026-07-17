const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const db = require('../db/database');
const { requireLogin, requireViewLeads, canEditLeads, isOwnScopeOnly } = require('../middleware/auth');

// "New" and "Joined" are always available regardless of what's actually been added to
// lead_statuses — "Joined" specifically because the conversion flow below sets it
// programmatically, and it should never silently disappear from the dropdown.
const BUILT_IN_STATUSES = ['New', 'Joined'];

async function statusList() {
  const custom = (await db.prepare(`SELECT name FROM lead_statuses ORDER BY name`).all()).map(r => r.name);
  return Array.from(new Set([...BUILT_IN_STATUSES, ...custom])).sort((a, b) => a.localeCompare(b));
}
async function courseList() {
  return (await db.prepare(`SELECT name FROM courses ORDER BY name`).all()).map(r => r.name);
}
async function activeSalesStaffList() {
  return db.prepare(`SELECT id, name FROM users WHERE role = 'sales_staff' AND active = 1 ORDER BY name`).all();
}
function showsSalesStaffPicker(user) {
  return user.role === 'admin' || user.role === 'staff';
}
function getFieldValue(select, otherText) {
  if (select === '__other__') return (otherText || '').trim() || null;
  return (select || '').trim() || null;
}
// Any Sales Team member (or anyone who can edit leads) can add a brand new status or
// course label directly — unlike the Courses catalog used for real enrollments, this is
// just pipeline vocabulary and doesn't need Admin gatekeeping.
async function maybeCreateStatus(name, user) {
  if (name && !BUILT_IN_STATUSES.includes(name)) {
    await db.prepare(`INSERT INTO lead_statuses (name, created_by) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`).run(name, user.id);
  }
}
async function maybeCreateCourse(name, user) {
  if (name) {
    await db.prepare(`INSERT INTO courses (name, created_by) VALUES (?, ?) ON CONFLICT (name) DO NOTHING`).run(name, user.id);
  }
}

// ---------- LIST (with filters across every field) ----------
router.get('/', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  let sql = `
    SELECT l.*, u.name AS sales_staff_name, c.name AS created_by_name
    FROM leads l
    LEFT JOIN users u ON u.id = l.sales_staff_id
    LEFT JOIN users c ON c.id = l.created_by
  `;
  const params = [];
  const conditions = [];

  if (isOwnScopeOnly(user)) {
    conditions.push('l.sales_staff_id = ?');
    params.push(user.id);
  }

  const { q, course, status, place, job, from, to, staff_id } = req.query;
  if (q) {
    conditions.push('(l.name ILIKE ? OR l.phone ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (course) { conditions.push('l.course_interested = ?'); params.push(course); }
  if (status) { conditions.push('l.status = ?'); params.push(status); }
  if (place) { conditions.push('l.place ILIKE ?'); params.push(`%${place}%`); }
  if (job) { conditions.push('l.job ILIKE ?'); params.push(`%${job}%`); }
  if (from) { conditions.push('l.lead_date >= ?'); params.push(from); }
  if (to) { conditions.push('l.lead_date <= ?'); params.push(to); }
  if (staff_id && !isOwnScopeOnly(user)) { conditions.push('l.sales_staff_id = ?'); params.push(staff_id); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY l.lead_date DESC, l.id DESC';

  const leads = await db.prepare(sql).all(...params);
  const statusCounts = leads.reduce((acc, l) => { acc[l.status] = (acc[l.status] || 0) + 1; return acc; }, {});

  res.render('leads_list', {
    user, leads, statusCounts,
    statuses: await statusList(), courses: await courseList(),
    staffList: isOwnScopeOnly(user) ? [] : await activeSalesStaffList(),
    filters: { q: q || '', course: course || '', status: status || '', place: place || '', job: job || '', from: from || '', to: to || '', staff_id: staff_id || '' },
    canEdit: canEditLeads(user),
  });
});

// ---------- EXPORT ----------
router.get('/export', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  let sql = `
    SELECT l.lead_date, l.phone, l.name, l.course_interested, l.place, l.job, l.remarks, l.last_chat_notes, l.status,
           u.name AS sales_staff_name
    FROM leads l
    LEFT JOIN users u ON u.id = l.sales_staff_id
  `;
  const params = [];
  const conditions = [];
  if (isOwnScopeOnly(user)) { conditions.push('l.sales_staff_id = ?'); params.push(user.id); }
  const { q, course, status, place, job, from, to, staff_id } = req.query;
  if (q) { conditions.push('(l.name ILIKE ? OR l.phone ILIKE ?)'); const like = `%${q}%`; params.push(like, like); }
  if (course) { conditions.push('l.course_interested = ?'); params.push(course); }
  if (status) { conditions.push('l.status = ?'); params.push(status); }
  if (place) { conditions.push('l.place ILIKE ?'); params.push(`%${place}%`); }
  if (job) { conditions.push('l.job ILIKE ?'); params.push(`%${job}%`); }
  if (from) { conditions.push('l.lead_date >= ?'); params.push(from); }
  if (to) { conditions.push('l.lead_date <= ?'); params.push(to); }
  if (staff_id && !isOwnScopeOnly(user)) { conditions.push('l.sales_staff_id = ?'); params.push(staff_id); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY l.lead_date DESC, l.id DESC';

  const rows = await db.prepare(sql).all(...params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.columns = [
    { header: 'Date of Lead', key: 'lead_date', width: 14 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Course Looking For', key: 'course_interested', width: 20 },
    { header: 'Place', key: 'place', width: 16 },
    { header: 'Job', key: 'job', width: 18 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Sales Team', key: 'sales_staff_name', width: 18 },
    { header: 'Last Chat Notes', key: 'last_chat_notes', width: 30 },
    { header: 'Remarks', key: 'remarks', width: 26 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } };
  rows.forEach(r => sheet.addRow(r));
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: 10 } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---------- NEW ----------
router.get('/new', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (!canEditLeads(user)) return res.status(403).render('error', { message: 'You do not have permission to add leads.', user });
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  res.render('lead_form', {
    user, isEdit: false, lead: { lead_date: new Date().toISOString().slice(0, 10) },
    staffList, statuses: await statusList(), courses: await courseList(), error: null,
  });
});

router.post('/', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (!canEditLeads(user)) return res.status(403).render('error', { message: 'You do not have permission to add leads.', user });

  const b = req.body;
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];

  if (!b.lead_date || !b.name || !b.phone) {
    return res.render('lead_form', { user, isEdit: false, lead: b, staffList, statuses: await statusList(), courses: await courseList(), error: 'Date of Lead, Name, and Phone are all required.' });
  }

  let sales_staff_id;
  if (user.role === 'sales_staff') {
    sales_staff_id = user.id;
  } else {
    sales_staff_id = parseInt(b.sales_staff_id, 10) || null;
    if (!sales_staff_id || !staffList.some(s => s.id === sales_staff_id)) {
      return res.render('lead_form', { user, isEdit: false, lead: b, staffList, statuses: await statusList(), courses: await courseList(), error: 'Select which Sales Team member this lead belongs to.' });
    }
  }

  const course = getFieldValue(b.course_select, b.course_other);
  const status = getFieldValue(b.status_select, b.status_other) || 'New';
  await maybeCreateCourse(course, user);
  await maybeCreateStatus(status, user);

  const result = await db.prepare(`
    INSERT INTO leads (lead_date, phone, name, course_interested, place, job, remarks, last_chat_notes, status, sales_staff_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(b.lead_date, b.phone, b.name, course, b.place || null, b.job || null, b.remarks || null, b.last_chat_notes || null, status, sales_staff_id, user.id);

  res.redirect('/leads/' + result.lastInsertRowid);
});

// ---------- VIEW ----------
router.get('/:id', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  const lead = await db.prepare(`
    SELECT l.*, u.name AS sales_staff_name
    FROM leads l LEFT JOIN users u ON u.id = l.sales_staff_id
    WHERE l.id = ?
  `).get(req.params.id);
  if (!lead) return res.status(404).render('error', { message: 'Lead not found.', user });
  if (isOwnScopeOnly(user) && lead.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only view leads assigned to you.', user });
  }
  res.render('lead_detail', { user, lead, statuses: await statusList(), canEdit: canEditLeads(user) });
});

// ---------- EDIT ----------
router.get('/:id/edit', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (!canEditLeads(user)) return res.status(403).render('error', { message: 'You do not have permission to edit leads.', user });
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).render('error', { message: 'Lead not found.', user });
  if (isOwnScopeOnly(user) && lead.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only edit leads assigned to you.', user });
  }
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];
  res.render('lead_form', { user, isEdit: true, lead, staffList, statuses: await statusList(), courses: await courseList(), error: null });
});

router.post('/:id', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (!canEditLeads(user)) return res.status(403).render('error', { message: 'You do not have permission to edit leads.', user });
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).render('error', { message: 'Lead not found.', user });
  if (isOwnScopeOnly(user) && lead.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only edit leads assigned to you.', user });
  }

  const b = req.body;
  const staffList = showsSalesStaffPicker(user) ? await activeSalesStaffList() : [];

  if (!b.lead_date || !b.name || !b.phone) {
    return res.render('lead_form', { user, isEdit: true, lead: { ...lead, ...b }, staffList, statuses: await statusList(), courses: await courseList(), error: 'Date of Lead, Name, and Phone are all required.' });
  }

  let sales_staff_id = lead.sales_staff_id;
  if (showsSalesStaffPicker(user) && b.sales_staff_id) {
    const candidate = parseInt(b.sales_staff_id, 10);
    if (!candidate || !staffList.some(s => s.id === candidate)) {
      return res.render('lead_form', { user, isEdit: true, lead: { ...lead, ...b }, staffList, statuses: await statusList(), courses: await courseList(), error: 'Select a valid Sales Team member.' });
    }
    sales_staff_id = candidate;
  }

  const course = getFieldValue(b.course_select, b.course_other);
  const status = getFieldValue(b.status_select, b.status_other) || lead.status;
  await maybeCreateCourse(course, user);
  await maybeCreateStatus(status, user);

  await db.prepare(`
    UPDATE leads SET lead_date = ?, phone = ?, name = ?, course_interested = ?, place = ?, job = ?, remarks = ?, last_chat_notes = ?, status = ?, sales_staff_id = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `).run(b.lead_date, b.phone, b.name, course, b.place || null, b.job || null, b.remarks || null, b.last_chat_notes || null, status, sales_staff_id, lead.id);

  res.redirect('/leads/' + lead.id);
});

// Quick status update from the list or detail page, without a full edit.
router.post('/:id/status', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (!canEditLeads(user)) return res.status(403).render('error', { message: 'You do not have permission to update leads.', user });
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).render('error', { message: 'Lead not found.', user });
  if (isOwnScopeOnly(user) && lead.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only update leads assigned to you.', user });
  }
  const status = getFieldValue(req.body.status_select, req.body.status_other) || lead.status;
  await maybeCreateStatus(status, user);
  await db.prepare(`UPDATE leads SET status = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`).run(status, lead.id);
  const referer = req.get('Referer') || '';
  res.redirect(referer.includes('/leads/' + lead.id) ? '/leads/' + lead.id : '/leads');
});

router.post('/:id/delete', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'admin') return res.status(403).render('error', { message: 'Only admin can delete leads.', user });
  await db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.redirect('/leads');
});

// ---------- CONVERT TO ADMISSION ----------
// Hands off to the existing student/enrollment creation flow — reused exactly as-is,
// just pre-filled and carrying a lead_id through so the lead can be marked "Joined" and
// linked once the admission is actually created (see routes/students.js & enrollments.js).
router.post('/:id/convert', requireLogin, requireViewLeads, async (req, res) => {
  const user = req.session.user;
  if (!canEditLeads(user)) return res.status(403).render('error', { message: 'You do not have permission to convert leads.', user });
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).render('error', { message: 'Lead not found.', user });
  if (isOwnScopeOnly(user) && lead.sales_staff_id !== user.id) {
    return res.status(403).render('error', { message: 'You can only convert leads assigned to you.', user });
  }
  if (lead.converted_enrollment_id) return res.redirect('/enrollments/' + lead.converted_enrollment_id);

  // If this phone number already belongs to an existing student, this becomes a new
  // Enrollment (another course) for them — not a duplicate profile.
  const existingPerson = await db.prepare(`SELECT id FROM persons WHERE phone_call = ? OR phone_whatsapp = ?`).get(lead.phone, lead.phone);

  const params = new URLSearchParams({
    lead_id: lead.id, name: lead.name, phone: lead.phone, course: lead.course_interested || '',
  });
  if (existingPerson) {
    res.redirect(`/students/${existingPerson.id}/enrollments/new?${params.toString()}`);
  } else {
    res.redirect(`/students/new?${params.toString()}`);
  }
});

module.exports = router;
