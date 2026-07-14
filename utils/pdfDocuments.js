const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { amountInWords } = require('./numberToWords');

const FONT_DIR = path.join(__dirname, 'fonts');
function registerFonts(doc) {
  doc.registerFont('Body', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
  doc.registerFont('Body-Bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
  doc.registerFont('Body-Italic', path.join(FONT_DIR, 'NotoSans-Italic.ttf'));
}

const NAVY = '#1E3350';
const OCHRE = '#B8712E';
const MUTED = '#6B7280';
const BORDER = '#E3E6EB';

function formatINR(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Logo/QR can now live either on local disk (path) or in Supabase Storage (a full URL) —
// pdfkit's doc.image() only accepts a local path or a Buffer, so a remote URL needs
// fetching into a buffer first.
async function loadImageSource(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    try {
      const res = await fetch(pathOrUrl);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      return null;
    }
  }
  return fs.existsSync(pathOrUrl) ? pathOrUrl : null;
}

async function drawHeader(doc, company, docTitle, rightLines) {
  // The document title sits on its own full-width row at the very top of the page —
  // deliberately not sharing space with the company name, so a long title like
  // "RECEIPT VOUCHER" can never wrap into and collide with anything else.
  doc.fillColor(NAVY).font('Body-Bold').fontSize(22).text(docTitle, 40, 40, { width: 515, align: 'center' });

  const rowY = 100;
  let textX = 40;
  const logoSource = await loadImageSource(company.logo_path);
  if (logoSource) {
    try {
      doc.image(logoSource, 40, rowY, { fit: [60, 60] });
      textX = 112;
    } catch (e) { /* ignore a broken image file rather than crash PDF generation */ }
  }

  doc.fillColor(NAVY).font('Body-Bold').fontSize(14).text(company.company_name || 'Your Institution Name', textX, rowY, { width: 295 });
  doc.fillColor(MUTED).font('Body').fontSize(9);
  let leftY = rowY + 18;
  if (company.address) { doc.text(company.address, textX, leftY, { width: 295 }); leftY += doc.heightOfString(company.address, { width: 295 }) + 2; }
  const contactBits = [company.phone, company.email, company.gstin ? 'GSTIN: ' + company.gstin : null].filter(Boolean).join('   ·   ');
  if (contactBits) { doc.text(contactBits, textX, leftY, { width: 295 }); leftY += 13; }
  leftY = Math.max(leftY, rowY + 60); // never less tall than the logo

  // Right column: whatever lines the caller wants (No / Date / Due Date, etc.) — passed in
  // explicitly rather than guessed at, so there's no fragile position math between documents.
  doc.fillColor(MUTED).font('Body').fontSize(9);
  let rightY = rowY;
  rightLines.forEach(line => { doc.text(line, 350, rightY, { width: 205, align: 'right' }); rightY += 14; });

  const dividerY = Math.max(leftY, rightY) + 12;
  doc.moveTo(40, dividerY).lineTo(555, dividerY).strokeColor(BORDER).lineWidth(1).stroke();
  return dividerY + 20;
}

function drawPartyBlock(doc, y, label, student) {
  doc.fillColor(MUTED).font('Body-Bold').fontSize(9).text(label.toUpperCase(), 40, y);
  doc.fillColor('#1F2430').font('Body-Bold').fontSize(12).text(student.name, 40, y + 14);
  doc.fillColor(MUTED).font('Body').fontSize(9);
  let ly = y + 32;
  doc.text(`Student ID: ${student.student_code}`, 40, ly); ly += 13;
  if (student.phone_call || student.phone_whatsapp) { doc.text(`Phone: ${student.phone_call || student.phone_whatsapp}`, 40, ly); ly += 13; }
  if (student.email) { doc.text(`Email: ${student.email}`, 40, ly); ly += 13; }
  return ly + 10;
}

function drawLineItemTable(doc, y, rows, total) {
  const colDescX = 40, colAmountX = 460, tableWidth = 515, rowHeight = 26;
  doc.rect(40, y, tableWidth, rowHeight).fill('#EFF2F7');
  doc.fillColor(NAVY).font('Body-Bold').fontSize(9);
  doc.text('DESCRIPTION', colDescX + 8, y + 8);
  doc.text('AMOUNT', colAmountX, y + 8, { width: 87, align: 'right' });
  y += rowHeight;

  doc.font('Body').fontSize(10).fillColor('#1F2430');
  rows.forEach(row => {
    const lineHeight = Math.max(20, doc.heightOfString(row.description, { width: 400 }) + 6);
    doc.text(row.description, colDescX + 8, y + 6, { width: 400 });
    doc.text(formatINR(row.amount), colAmountX, y + 6, { width: 87, align: 'right' });
    doc.moveTo(40, y + lineHeight).lineTo(555, y + lineHeight).strokeColor(BORDER).lineWidth(0.5).stroke();
    y += lineHeight;
  });

  // Total row
  doc.rect(40, y, tableWidth, rowHeight).fill('#FAFBFC');
  doc.font('Body-Bold').fontSize(10).fillColor(NAVY);
  doc.text('TOTAL', colDescX + 8, y + 8);
  doc.text(formatINR(total), colAmountX, y + 8, { width: 87, align: 'right' });
  y += rowHeight;

  return y + 15;
}

function drawAmountInWords(doc, y, amount) {
  doc.fillColor(MUTED).font('Body-Italic').fontSize(9.5)
    .text(amountInWords(amount), 40, y, { width: 515 });
  return y + doc.heightOfString(amountInWords(amount), { width: 515 }) + 15;
}

function drawTerms(doc, y, terms) {
  if (!terms) return y;
  doc.fillColor(MUTED).font('Body-Bold').fontSize(9).text('TERMS & CONDITIONS', 40, y);
  y += 14;
  doc.font('Body').fontSize(8.5).fillColor(MUTED).text(terms, 40, y, { width: 515, lineGap: 2 });
  return y + doc.heightOfString(terms, { width: 515, lineGap: 2 }) + 20;
}

function drawFooter(doc, minY) {
  const y = Math.max(760, minY || 0);
  doc.moveTo(400, y).lineTo(555, y).strokeColor(BORDER).lineWidth(1).stroke();
  doc.fillColor(MUTED).font('Body').fontSize(8.5).text('Authorized Signatory', 400, y + 6, { width: 155, align: 'center' });
  doc.fontSize(7.5).fillColor('#B0B5BD').text('This is a computer-generated document.', 40, y + 6);
  return y;
}

// Bank details (left) + a QR code (right), if either is set. The QR is either the exact
// image the institution uploaded (their bank/UPI app's own QR), or — only if none was
// uploaded — an auto-generated UPI QR scoped to this invoice's exact amount.
async function drawPaymentDetails(doc, y, company, amount) {
  const hasBank = company.bank_account_number || company.bank_name;
  const uploadedQrSource = await loadImageSource(company.qr_code_path);
  const hasUploadedQr = !!uploadedQrSource;
  const hasUpi = !hasUploadedQr && !!company.upi_id;
  if (!hasBank && !hasUploadedQr && !hasUpi) return y;

  const sectionTop = y;
  if (hasBank) {
    doc.fillColor(MUTED).font('Body-Bold').fontSize(9).text('BANK DETAILS', 40, y);
    y += 14;
    doc.font('Body').fontSize(9).fillColor('#1F2430');
    const lines = [
      company.bank_account_name ? `Account Name: ${company.bank_account_name}` : null,
      company.bank_name ? `Bank: ${company.bank_name}` : null,
      company.bank_account_number ? `Account No: ${company.bank_account_number}` : null,
      company.bank_ifsc ? `IFSC: ${company.bank_ifsc}` : null,
      company.bank_branch ? `Branch: ${company.bank_branch}` : null,
    ].filter(Boolean);
    lines.forEach(line => { doc.text(line, 40, y, { width: 320 }); y += 13; });
  }

  if (hasUploadedQr) {
    try {
      doc.image(uploadedQrSource, 440, sectionTop, { fit: [90, 90] });
      doc.fillColor(MUTED).font('Body').fontSize(8).text('Scan to pay', 425, sectionTop + 92, { width: 120, align: 'center' });
    } catch (e) { /* skip rather than fail the whole PDF if the file is unreadable */ }
  } else if (hasUpi) {
    try {
      const upiUri = `upi://pay?pa=${encodeURIComponent(company.upi_id)}&pn=${encodeURIComponent(company.company_name || 'Payee')}&am=${encodeURIComponent(Number(amount || 0).toFixed(2))}&cu=INR`;
      const qrBuffer = await QRCode.toBuffer(upiUri, { width: 110, margin: 1 });
      doc.image(qrBuffer, 440, sectionTop, { width: 90 });
      doc.fillColor(MUTED).font('Body').fontSize(8).text('Scan to pay via UPI', 425, sectionTop + 92, { width: 120, align: 'center' });
    } catch (e) { /* skip the QR rather than fail the whole PDF if generation errors out */ }
  }

  return Math.max(y, sectionTop + ((hasUploadedQr || hasUpi) ? 110 : 0)) + 15;
}

async function generateInvoicePdf(res, { company, student, invoice }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  registerFonts(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  doc.pipe(res);

  const rightLines = [`No: ${invoice.invoice_number}`, `Date: ${invoice.issue_date}`];
  if (invoice.due_date) rightLines.push(`Due: ${invoice.due_date}`);
  let y = await drawHeader(doc, company, 'INVOICE', rightLines);
  y = drawPartyBlock(doc, y, 'Billed To', student);
  y += 10;
  y = drawLineItemTable(doc, y, [{ description: invoice.description || student.course || 'Course Fee', amount: invoice.amount }], invoice.amount);
  y = drawAmountInWords(doc, y, invoice.amount);
  if (invoice.notes) {
    doc.fillColor(MUTED).font('Body').fontSize(9).text(invoice.notes, 40, y, { width: 515 });
    y += doc.heightOfString(invoice.notes, { width: 515 }) + 15;
  }
  y = await drawPaymentDetails(doc, y, company, invoice.amount);
  y = drawTerms(doc, y, company.invoice_terms);
  drawFooter(doc, y + 10);

  doc.end();
}

async function generateReceiptPdf(res, { company, student, receipt }) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  registerFonts(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${receipt.receipt_number}.pdf"`);
  doc.pipe(res);

  let y = await drawHeader(doc, company, 'RECEIPT VOUCHER', [`No: ${receipt.receipt_number}`, `Date: ${receipt.receipt_date}`]);
  y = drawPartyBlock(doc, y, 'Received From', student);
  y += 10;
  const desc = 'Fee payment' + (student.course ? ' - ' + student.course : '');
  y = drawLineItemTable(doc, y, [{ description: desc, amount: receipt.amount }], receipt.amount);
  y = drawAmountInWords(doc, y, receipt.amount);
  const extra = [receipt.payment_mode ? `Payment mode: ${receipt.payment_mode}` : null, receipt.notes || null].filter(Boolean).join('   ·   ');
  if (extra) {
    doc.fillColor(MUTED).font('Body').fontSize(9).text(extra, 40, y, { width: 515 });
    y += doc.heightOfString(extra, { width: 515 }) + 15;
  }
  y = drawTerms(doc, y, company.receipt_terms);
  drawFooter(doc, y + 10);

  doc.end();
}

module.exports = { generateInvoicePdf, generateReceiptPdf };
