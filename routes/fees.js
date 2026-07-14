const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const db = require('../db/database');
const { requireLogin, requireViewFees, canViewFeeCollected, isOwnScopeOnly } = require('../middleware/auth');

async function buildLedgerQuery(user, query) {
  let sql = `
    SELECT f.*, p.person_code AS student_code, p.name AS student_name, e.total_fee, e.sales_staff_id, e.id AS enrollment_id,
           (SELECT STRING_AGG(b.name, ', ') FROM enrollment_batches eb JOIN batches b ON b.id = eb.batch_id WHERE eb.enrollment_id = e.id) AS batch_name,
           u.name AS collected_by_name
    FROM fee_collections f
    JOIN enrollments e ON e.id = f.enrollment_id
    JOIN persons p ON p.id = e.person_id
    LEFT JOIN users u ON u.id = f.collected_by
  `;
  const params = [];
  const conditions = [];

  if (isOwnScopeOnly(user)) {
    conditions.push('e.sales_staff_id = ?');
    params.push(user.id);
  }

  const { from, to } = query;
  if (from) { conditions.push('f.collection_date >= ?'); params.push(from); }
  if (to) { conditions.push('f.collection_date <= ?'); params.push(to); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY f.collection_date DESC, f.id DESC';

  return db.prepare(sql).all(...params);
}

// Consolidated fee collection ledger, linked back to student master data
router.get('/', requireLogin, requireViewFees, async (req, res) => {
  const user = req.session.user;

  if (!canViewFeeCollected(user)) {
    return res.status(403).render('error', { message: 'You do not have permission to view fee collection entries. Ask your Admin to grant "Fee Collected" view access.', user });
  }

  const entries = await buildLedgerQuery(user, req.query);
  const totalCollected = entries.reduce((sum, e) => sum + e.amount, 0);
  const { from, to } = req.query;

  res.render('fees_list', { user, entries, totalCollected, filters: { from: from || '', to: to || '' } });
});

// Date-wise export of the complete fee collection ledger
router.get('/export', requireLogin, requireViewFees, async (req, res) => {
  const user = req.session.user;
  if (!canViewFeeCollected(user)) {
    return res.status(403).render('error', { message: 'You do not have permission to export fee collection entries. Ask your Admin to grant "Fee Collected" view access.', user });
  }

  const entries = await buildLedgerQuery(user, req.query);
  const { from, to } = req.query;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Fee Collections');
  sheet.columns = [
    { header: 'Collection Date', key: 'collection_date', width: 14 },
    { header: 'Student ID', key: 'student_code', width: 12 },
    { header: 'Student Name', key: 'student_name', width: 22 },
    { header: 'Batch', key: 'batch_name', width: 20 },
    { header: 'Amount Collected', key: 'amount', width: 16 },
    { header: 'Collected By', key: 'collected_by_name', width: 18 },
    { header: 'Notes', key: 'notes', width: 28 },
    { header: 'Total Fee (Enrollment)', key: 'total_fee', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } };
  entries.forEach(e => sheet.addRow(e));
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: 8 } };

  const totalRow = sheet.addRow({ collection_date: '', student_code: '', student_name: '', batch_name: 'TOTAL', amount: entries.reduce((s, e) => s + e.amount, 0) });
  totalRow.font = { bold: true };

  const rangeLabel = (from || to) ? `${from || 'start'}_to_${to || 'today'}` : 'all-time';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="fee-collections-${rangeLabel}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
