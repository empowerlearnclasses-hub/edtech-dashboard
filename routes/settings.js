const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db/database');
const { requireLogin, requireAdmin } = require('../middleware/auth');

// If Supabase Storage credentials are set, uploads go there (this is what makes logos and
// QR codes survive on a host with no persistent disk, like Render's free tier). Otherwise,
// this falls back to writing to UPLOAD_DIR on local disk — unchanged local-dev behavior.
const useSupabaseStorage = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
let supabase = null;
if (useSupabaseStorage) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const LOGO_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
if (!useSupabaseStorage && !fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });

const upload = multer({
  storage: useSupabaseStorage
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => cb(null, LOGO_DIR),
        filename: (req, file, cb) => {
          const base = file.fieldname === 'qr_code' ? 'qrcode' : 'logo';
          cb(null, base + path.extname(file.originalname).toLowerCase());
        },
      }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.png', '.jpg', '.jpeg'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Images must be PNG or JPG.'), ok);
  },
});
const uploadFields = upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'qr_code', maxCount: 1 }]);

// Uploads the given multer file (memory buffer) to Supabase Storage and returns its public URL.
async function uploadToSupabase(file, baseName) {
  const objectName = baseName + path.extname(file.originalname).toLowerCase();
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(objectName, file.buffer, {
    contentType: file.mimetype,
    upsert: true,
  });
  if (error) throw new Error('Upload to Supabase Storage failed: ' + error.message);
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectName);
  return data.publicUrl;
}

router.get('/company', requireLogin, requireAdmin, async (req, res) => {
  const settings = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  res.render('settings_company', { user: req.session.user, settings, error: null, success: null });
});

router.post('/company', requireLogin, requireAdmin, (req, res, next) => {
  uploadFields(req, res, async (err) => {
    if (err) {
      const settings = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
      return res.render('settings_company', { user: req.session.user, settings, error: err.message, success: null });
    }
    next();
  });
}, async (req, res) => {
  const b = req.body;
  const current = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();

  let logo_path = current.logo_path;
  let qr_code_path = current.qr_code_path;

  try {
    if (req.files && req.files.logo) {
      logo_path = useSupabaseStorage
        ? await uploadToSupabase(req.files.logo[0], 'logo')
        : req.files.logo[0].path;
    }
    if (req.files && req.files.qr_code) {
      qr_code_path = useSupabaseStorage
        ? await uploadToSupabase(req.files.qr_code[0], 'qrcode')
        : req.files.qr_code[0].path;
    }
  } catch (e) {
    return res.render('settings_company', { user: req.session.user, settings: current, error: e.message, success: null });
  }

  await db.prepare(`
    UPDATE company_settings SET
      company_name = ?, address = ?, phone = ?, email = ?, gstin = ?,
      logo_path = ?, qr_code_path = ?, invoice_terms = ?, receipt_terms = ?,
      bank_account_name = ?, bank_name = ?, bank_account_number = ?, bank_ifsc = ?, bank_branch = ?, upi_id = ?,
      updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = 1
  `).run(
    b.company_name || null, b.address || null, b.phone || null, b.email || null, b.gstin || null,
    logo_path, qr_code_path, b.invoice_terms || null, b.receipt_terms || null,
    b.bank_account_name || null, b.bank_name || null, b.bank_account_number || null, b.bank_ifsc || null, b.bank_branch || null, b.upi_id || null
  );

  const settings = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  res.render('settings_company', { user: req.session.user, settings, error: null, success: 'Settings saved.' });
});

router.post('/company/logo/remove', requireLogin, requireAdmin, async (req, res) => {
  await db.prepare(`UPDATE company_settings SET logo_path = NULL WHERE id = 1`).run();
  res.redirect('/settings/company');
});

router.post('/company/qr-code/remove', requireLogin, requireAdmin, async (req, res) => {
  await db.prepare(`UPDATE company_settings SET qr_code_path = NULL WHERE id = 1`).run();
  res.redirect('/settings/company');
});

module.exports = router;
