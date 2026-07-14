const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, canCreateInvoicesForStudent, canEditInvoicesForStudent, canViewInvoicesForStudent } = require('../middleware/auth');
const { generateInvoicePdf } = require('../utils/pdfDocuments');

async function nextInvoiceNumber() {
  const row = await db.prepare(`SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1`).get();
  let n = 1;
  if (row && row.invoice_number) {
    const match = row.invoice_number.match(/(\d+)$/);
    if (match) n = parseInt(match[1], 10) + 1;
  }
  return 'INV-' + String(n).padStart(4, '0');
}

async function getBillingParty(enrollmentId) {
  return db.prepare(`
    SELECT e.*, p.person_code AS student_code, p.name, p.phone_call, p.phone_whatsapp, p.email
    FROM enrollments e JOIN persons p ON p.id = e.person_id
    WHERE e.id = ?
  `).get(enrollmentId);
}

// ---------- CREATE (from an enrollment's page) ----------
router.post('/enrollments/:enrollmentId/invoices', requireLogin, async (req, res) => {
  const user = req.session.user;
  const party = await getBillingParty(req.params.enrollmentId);
  if (!party) return res.status(404).render('error', { message: 'Enrollment not found.', user });
  if (!canCreateInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to create invoices for this student.', user });
  }

  const b = req.body;
  if (!b.issue_date || !b.amount) {
    return res.status(400).render('error', { message: 'Issue date and amount are required to create an invoice.', user });
  }

  const invoice_number = await nextInvoiceNumber();
  const result = await db.prepare(`
    INSERT INTO invoices (invoice_number, enrollment_id, issue_date, due_date, description, amount, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(invoice_number, party.id, b.issue_date, b.due_date || null, b.description || 'Course Fee', parseFloat(b.amount) || 0, b.notes || null, user.id);

  res.redirect('/invoices/' + result.lastInsertRowid);
});

// ---------- VIEW ----------
router.get('/invoices/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.', user });
  const party = await getBillingParty(invoice.enrollment_id);
  if (!canViewInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to view this invoice.', user });
  }
  res.render('invoice_view', { user, invoice, student: party, canEdit: canEditInvoicesForStudent(user, party) });
});

// ---------- EDIT ----------
router.get('/invoices/:id/edit', requireLogin, async (req, res) => {
  const user = req.session.user;
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.', user });
  const party = await getBillingParty(invoice.enrollment_id);
  if (!canEditInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to edit this invoice.', user });
  }
  res.render('invoice_form', { user, invoice, student: party, error: null });
});

router.post('/invoices/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.', user });
  const party = await getBillingParty(invoice.enrollment_id);
  if (!canEditInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to edit this invoice.', user });
  }

  const b = req.body;
  if (!b.issue_date || !b.amount) {
    return res.render('invoice_form', { user, invoice: { ...invoice, ...b }, student: party, error: 'Issue date and amount are required.' });
  }

  await db.prepare(`
    UPDATE invoices SET issue_date = ?, due_date = ?, description = ?, amount = ?, notes = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `).run(b.issue_date, b.due_date || null, b.description || 'Course Fee', parseFloat(b.amount) || 0, b.notes || null, invoice.id);

  res.redirect('/invoices/' + invoice.id);
});

router.post('/invoices/:id/delete', requireLogin, async (req, res) => {
  const user = req.session.user;
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.', user });
  const party = await getBillingParty(invoice.enrollment_id);
  if (!canEditInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to delete this invoice.', user });
  }
  await db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
  res.redirect('/enrollments/' + party.id);
});

// ---------- PDF ----------
router.get('/invoices/:id/pdf', requireLogin, async (req, res) => {
  const user = req.session.user;
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.', user });
  const party = await getBillingParty(invoice.enrollment_id);
  if (!canViewInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to view this invoice.', user });
  }
  const company = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  try {
    await generateInvoicePdf(res, { company, student: party, invoice });
  } catch (e) {
    if (!res.headersSent) res.status(500).render('error', { message: 'Something went wrong generating this invoice PDF.', user });
  }
});

module.exports = router;
