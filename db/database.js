const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Postgres returns BIGINT (used for COUNT(*)) and NUMERIC (used for fee/amount SUMs) as
// strings by default, to avoid precision loss outside JS's safe integer range. Every
// amount and count in this app is small enough that this isn't a real concern, and every
// existing call site already expects a plain JS number — so these are parsed as numbers
// globally, once, rather than needing an explicit cast on every COUNT(*)/SUM(...) query.
types.setTypeParser(20, (val) => parseInt(val, 10)); // BIGINT — e.g. COUNT(*)
types.setTypeParser(1700, (val) => parseFloat(val)); // NUMERIC — e.g. SUM(total_fee)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and set it to your Supabase connection string (or a local Postgres one for development).');
  process.exit(1);
}

// A recent pg-connection-string change made 'sslmode=require' (and 'prefer'/'verify-ca')
// behave as an alias for 'verify-full' — meaning if that query param is left in the
// connection string, it silently overrides the explicit ssl option below and does full
// certificate-chain verification, which fails against Supabase's cert. Stripping it out
// and controlling SSL purely through the explicit `ssl` option avoids that conflict.
let connectionString = process.env.DATABASE_URL;
try {
  const parsed = new URL(connectionString);
  parsed.searchParams.delete('sslmode');
  connectionString = parsed.toString();
} catch (e) { /* fall through and use the string as-is if it doesn't parse as a URL */ }

const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  // Supabase (and most hosted Postgres) requires SSL, but with a certificate chain that
  // Node doesn't automatically trust — this is the standard, documented way to connect.
  // A local Postgres instance skips this entirely.
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err.message);
});

// ---------- SCHEMA ----------
// This is the full, current-state schema — unlike the old SQLite version of this file,
// there's no incremental migration history to replay here, since a fresh Supabase project
// starts empty. Every table already matches the app's current feature set.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','sales_staff','staff','faculty')),
  active INTEGER NOT NULL DEFAULT 1,
  designation TEXT,
  perm_view_students INTEGER NOT NULL DEFAULT 0,
  perm_edit_students INTEGER NOT NULL DEFAULT 0,
  perm_view_fee_allocated INTEGER NOT NULL DEFAULT 0,
  perm_edit_fee_allocated INTEGER NOT NULL DEFAULT 0,
  perm_view_fee_collected INTEGER NOT NULL DEFAULT 0,
  perm_edit_fee_collected INTEGER NOT NULL DEFAULT 0,
  perm_view_fee_due INTEGER NOT NULL DEFAULT 0,
  perm_view_fee_ageing INTEGER NOT NULL DEFAULT 0,
  perm_view_fee_due_percentage INTEGER NOT NULL DEFAULT 0,
  perm_view_batches INTEGER NOT NULL DEFAULT 0,
  perm_edit_batches INTEGER NOT NULL DEFAULT 0,
  perm_edit_courses INTEGER NOT NULL DEFAULT 0,
  perm_view_invoices INTEGER NOT NULL DEFAULT 0,
  perm_edit_invoices INTEGER NOT NULL DEFAULT 0,
  perm_view_leads INTEGER NOT NULL DEFAULT 0,
  perm_edit_leads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  gstin TEXT,
  logo_path TEXT,
  qr_code_path TEXT,
  invoice_terms TEXT,
  receipt_terms TEXT,
  bank_account_name TEXT,
  bank_name TEXT,
  bank_account_number TEXT,
  bank_ifsc TEXT,
  bank_branch TEXT,
  upi_id TEXT,
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Free-form pipeline stages (New, Follow-up, Not Interested, Joined, ...) — unlike
-- Courses, any Sales Team member can add a new one directly, no permission gate; this is
-- their own pipeline-tracking vocabulary, not something that affects billing structure.
CREATE TABLE IF NOT EXISTS lead_statuses (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  start_date TEXT,
  end_date TEXT,
  faculty_id INTEGER REFERENCES users(id),
  faculty_name TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS batch_sessions (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working' CHECK(status IN ('working','leave','holiday')),
  zoom_link TEXT,
  notes TEXT,
  class_completed INTEGER NOT NULL DEFAULT 0,
  recording_uploaded INTEGER NOT NULL DEFAULT 0,
  UNIQUE(batch_id, session_date)
);

CREATE TABLE IF NOT EXISTS persons (
  id SERIAL PRIMARY KEY,
  person_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone_whatsapp TEXT,
  phone_call TEXT,
  email TEXT,
  location TEXT,
  district TEXT,
  state TEXT,
  pincode TEXT,
  job_role TEXT,
  job_business_name TEXT,
  job_location TEXT,
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS enrollments (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  sales_staff_id INTEGER NOT NULL REFERENCES users(id),
  added_by INTEGER REFERENCES users(id),
  course TEXT,
  joined_date TEXT,
  total_fee NUMERIC NOT NULL DEFAULT 0,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dropout')),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- A student can attend more than one batch for the same course (e.g. a morning AND an
-- evening session) — the fee/course/status stays on the ONE enrollment above; this table
-- just tracks which batch(es) that one enrollment is scheduled into.
CREATE TABLE IF NOT EXISTS enrollment_batches (
  id SERIAL PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  UNIQUE(enrollment_id, batch_id)
);

-- Admission leads — the thing that used to live in a WhatsApp-fed Excel/Google Sheet.
-- "Joined" is a special status (not just another label): once a lead is converted into a
-- real admission (a Person + Enrollment), converted_enrollment_id links back to it, and
-- the lead's status becomes "Joined" automatically — see routes/students.js and
-- routes/enrollments.js, which both accept an optional lead_id to close this loop.
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  lead_date TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  course_interested TEXT,
  place TEXT,
  job TEXT,
  remarks TEXT,
  last_chat_notes TEXT,
  status TEXT NOT NULL DEFAULT 'New',
  sales_staff_id INTEGER NOT NULL REFERENCES users(id),
  converted_enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS fee_collections (
  id SERIAL PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  collection_date TEXT NOT NULL,
  collected_by INTEGER NOT NULL REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  description TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS receipt_vouchers (
  id SERIAL PRIMARY KEY,
  receipt_number TEXT UNIQUE NOT NULL,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  fee_collection_id INTEGER REFERENCES fee_collections(id) ON DELETE SET NULL,
  receipt_date TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  payment_mode TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('general','batch','students')),
  batch_id INTEGER REFERENCES batches(id),
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS task_students (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
  completed_at TEXT,
  notes TEXT,
  UNIQUE(task_id, enrollment_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_person ON enrollments(person_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_sales_staff ON enrollments(sales_staff_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_batches_enrollment ON enrollment_batches(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_batches_batch ON enrollment_batches(batch_id);
CREATE INDEX IF NOT EXISTS idx_fee_enrollment ON fee_collections(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_batch_sessions_batch ON batch_sessions(batch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_task_students_task ON task_students(task_id);
CREATE INDEX IF NOT EXISTS idx_task_students_enrollment ON task_students(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_invoices_enrollment ON invoices(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_enrollment ON receipt_vouchers(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_fee_collection ON receipt_vouchers(fee_collection_id);
CREATE INDEX IF NOT EXISTS idx_leads_sales_staff ON leads(sales_staff_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
`;

async function initSchema() {
  await pool.query(SCHEMA_SQL);

  // Add any users columns introduced after this database was first created — a fresh
  // database already has these from SCHEMA_SQL above, so this is a no-op for it.
  const { rows: userCols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
  );
  const existingUserCols = userCols.map(r => r.column_name);
  for (const col of ['perm_view_leads', 'perm_edit_leads']) {
    if (!existingUserCols.includes(col)) {
      await pool.query(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      console.log(`Migrated users table: added column "${col}"`);
    }
  }

  // If this database was created before enrollment_batches existed, "enrollments" will
  // still have its old single batch_id column — migrate that data into the new
  // many-to-many table (one row each), then drop the column. A brand new database never
  // has this column, since SCHEMA_SQL above no longer defines it.
  const { rows: enrollmentCols } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'enrollments' AND column_name = 'batch_id'`
  );
  if (enrollmentCols.length > 0) {
    await pool.query(`
      INSERT INTO enrollment_batches (enrollment_id, batch_id)
      SELECT id, batch_id FROM enrollments WHERE batch_id IS NOT NULL
      ON CONFLICT (enrollment_id, batch_id) DO NOTHING
    `);
    await pool.query(`ALTER TABLE enrollments DROP COLUMN batch_id`);
    console.log('Migrated enrollments.batch_id into the new enrollment_batches table — a student can now be scheduled into more than one batch for the same course.');
  }

  const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (adminRows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(`
      INSERT INTO users (
        username, password, name, role, designation,
        perm_view_students, perm_edit_students,
        perm_view_fee_allocated, perm_edit_fee_allocated,
        perm_view_fee_collected, perm_edit_fee_collected,
        perm_view_fee_due, perm_view_fee_ageing, perm_view_fee_due_percentage,
        perm_view_batches, perm_edit_batches, perm_edit_courses,
        perm_view_invoices, perm_edit_invoices,
        perm_view_leads, perm_edit_leads
      )
      VALUES ($1, $2, $3, 'admin', 'Administrator', 1,1, 1,1, 1,1, 1,1,1, 1,1, 1, 1,1, 1,1)
    `, ['admin', hash, 'Administrator']);
    console.log('Seeded default admin user -> username: admin | password: admin123 (please change this after first login)');
  }

  const { rows: settingsRows } = await pool.query(`SELECT id FROM company_settings WHERE id = 1`);
  if (settingsRows.length === 0) {
    await pool.query(`INSERT INTO company_settings (id, company_name) VALUES (1, $1)`, ['Your Institution Name']);
  }

  console.log('Database schema ready.');
}

// ---------- better-sqlite3-compatible async shim ----------
// The rest of this app was written against better-sqlite3's synchronous
// db.prepare(sql).get/all/run(...params) shape. Rather than reshape every single query
// call site across the whole app, this shim keeps that exact calling convention — the
// only change needed elsewhere is adding `await` and marking the surrounding function
// `async`. It transparently handles:
//   - '?' positional placeholders -> Postgres's '$1, $2, ...'
//   - '@name' named placeholders (used by a few dynamically-built queries) -> positional,
//     reusing the same $N everywhere a name repeats, matching better-sqlite3's behavior
//   - auto-appending RETURNING id to bare INSERT statements, so `.lastInsertRowid` keeps
//     working without touching every INSERT call site (every table's primary key is `id`)
function toPositionalNamed(sql, namedParams) {
  const values = [];
  const seen = {};
  const text = sql.replace(/@(\w+)/g, (match, name) => {
    if (!(name in seen)) {
      values.push(namedParams ? namedParams[name] : undefined);
      seen[name] = values.length;
    }
    return '$' + seen[name];
  });
  return { text, values };
}
function toPositionalQmark(sql, params) {
  let i = 0;
  const text = sql.replace(/\?/g, () => '$' + (++i));
  return { text, values: params };
}
function withReturningId(sql) {
  const trimmed = sql.trim();
  if (/^INSERT\s+INTO/i.test(trimmed) && !/RETURNING/i.test(trimmed)) {
    return trimmed.replace(/;\s*$/, '') + ' RETURNING id';
  }
  return sql;
}
function buildQuery(sql, args, forRun) {
  const raw = forRun ? withReturningId(sql) : sql;
  // Decided by how the caller invoked it, not by whether the SQL text happens to still
  // contain '@name' placeholders right now — a dynamically-built WHERE clause can end up
  // with zero conditions on a given call even though the caller always passes an object.
  const isNamedStyle = args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]);
  return isNamedStyle
    ? toPositionalNamed(raw, args[0])
    : toPositionalQmark(raw, args);
}

function prepare(sql) {
  return {
    async get(...args) {
      const { text, values } = buildQuery(sql, args, false);
      const { rows } = await pool.query(text, values);
      return rows[0];
    },
    async all(...args) {
      const { text, values } = buildQuery(sql, args, false);
      const { rows } = await pool.query(text, values);
      return rows;
    },
    async run(...args) {
      const { text, values } = buildQuery(sql, args, true);
      const result = await pool.query(text, values);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows && result.rows[0] ? result.rows[0].id : undefined,
      };
    },
  };
}

module.exports = { pool, initSchema, prepare };
