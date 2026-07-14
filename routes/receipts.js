const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, canCreateInvoicesForStudent, canEditInvoicesForStudent, canViewInvoicesForStudent } = require('../middleware/auth');
const { generateReceiptPdf } = require('../utils/pdfDocuments');

async function nextReceiptNumber() {
  const row = await db.prepare(`SELECT receipt_number FROM receipt_vouchers ORDER BY id DESC LIMIT 1`).get();
  let n = 1;
  if (row && row.receipt_number) {
    const match = row.receipt_number.match(/(\d+)$/);
    if (match) n = parseInt(match[1], 10) + 1;
  }
  return 'RCT-' + String(n).padStart(4, '0');
}

async function getBillingParty(enrollmentId) {
  return db.prepare(`
    SELECT e.*, p.person_code AS student_code, p.name, p.phone_call, p.phone_whatsapp, p.email
    FROM enrollments e JOIN persons p ON p.id = e.person_id
    WHERE e.id = ?
  `).get(enrollmentId);
}

// ---------- CREATE (from an existing Fee Collection entry) ----------
router.post('/fee-collections/:feeId/receipt', requireLogin, async (req, res) => {
  const user = req.session.user;
  const fee = await db.prepare('SELECT * FROM fee_collections WHERE id = ?').get(req.params.feeId);
  if (!fee) return res.status(404).render('error', { message: 'Fee collection entry not found.', user });
  const party = await getBillingParty(fee.enrollment_id);
  if (!canCreateInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to generate a receipt for this student.', user });
  }

  const existing = await db.prepare('SELECT id FROM receipt_vouchers WHERE fee_collection_id = ?').get(fee.id);
  if (existing) return res.redirect('/receipts/' + existing.id);

  const receipt_number = await nextReceiptNumber();
  const result = await db.prepare(`
    INSERT INTO receipt_vouchers (receipt_number, enrollment_id, fee_collection_id, receipt_date, amount, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(receipt_number, party.id, fee.id, fee.collection_date, fee.amount, fee.notes || null, user.id);

  res.redirect('/receipts/' + result.lastInsertRowid);
});

// ---------- VIEW ----------
router.get('/receipts/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const receipt = await db.prepare('SELECT * FROM receipt_vouchers WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt voucher not found.', user });
  const party = await getBillingParty(receipt.enrollment_id);
  if (!canViewInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to view this receipt.', user });
  }
  res.render('receipt_view', { user, receipt, student: party, canEdit: canEditInvoicesForStudent(user, party) });
});

// ---------- EDIT ----------
router.get('/receipts/:id/edit', requireLogin, async (req, res) => {
  const user = req.session.user;
  const receipt = await db.prepare('SELECT * FROM receipt_vouchers WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt voucher not found.', user });
  const party = await getBillingParty(receipt.enrollment_id);
  if (!canEditInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to edit this receipt.', user });
  }
  res.render('receipt_form', { user, receipt, student: party, error: null });
});

router.post('/receipts/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const receipt = await db.prepare('SELECT * FROM receipt_vouchers WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt voucher not found.', user });
  const party = await getBillingParty(receipt.enrollment_id);
  if (!canEditInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to edit this receipt.', user });
  }

  const b = req.body;
  if (!b.receipt_date || !b.amount) {
    return res.render('receipt_form', { user, receipt: { ...receipt, ...b }, student: party, error: 'Receipt date and amount are required.' });
  }

  await db.prepare(`
    UPDATE receipt_vouchers SET receipt_date = ?, amount = ?, payment_mode = ?, notes = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `).run(b.receipt_date, parseFloat(b.amount) || 0, b.payment_mode || null, b.notes || null, receipt.id);

  res.redirect('/receipts/' + receipt.id);
});

router.post('/receipts/:id/delete', requireLogin, async (req, res) => {
  const user = req.session.user;
  const receipt = await db.prepare('SELECT * FROM receipt_vouchers WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt voucher not found.', user });
  const party = await getBillingParty(receipt.enrollment_id);
  if (!canEditInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to delete this receipt.', user });
  }
  await db.prepare('DELETE FROM receipt_vouchers WHERE id = ?').run(receipt.id);
  res.redirect('/enrollments/' + party.id);
});

// ---------- PDF ----------
router.get('/receipts/:id/pdf', requireLogin, async (req, res) => {
  const user = req.session.user;
  const receipt = await db.prepare('SELECT * FROM receipt_vouchers WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt voucher not found.', user });
  const party = await getBillingParty(receipt.enrollment_id);
  if (!canViewInvoicesForStudent(user, party)) {
    return res.status(403).render('error', { message: 'You do not have permission to view this receipt.', user });
  }
  const company = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  try {
    await generateReceiptPdf(res, { company, student: party, receipt });
  } catch (e) {
    if (!res.headersSent) res.status(500).render('error', { message: 'Something went wrong generating this receipt PDF.', user });
  }
});

module.exports = router;
