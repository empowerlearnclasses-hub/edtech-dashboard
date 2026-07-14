const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const methodOverride = require('method-override');
const path = require('path');
require('dotenv').config();

const { pool, initSchema } = require('./db/database');
const db = require('./db/database');
const { requireLogin, isOwnScopeOnly, isFacultyRole, canViewStudents, canViewFees, canViewBatches, getFeePerms } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Shared label for displaying a role — the underlying role value stays 'sales_staff'
// everywhere in the code/DB; only what's shown to people changes.
app.locals.roleLabel = (role) => {
  const labels = { admin: 'Admin', sales_staff: 'Sales Team', staff: 'Staff', faculty: 'Faculty' };
  return labels[role] || role;
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
// Served explicitly (not just via the public/ static mount above) so a hosted deployment
// can point UPLOAD_DIR at a persistent volume outside public/ and uploaded logos/QR codes
// still resolve at the same /uploads/... URLs the app already uses.
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads')));

app.use(session({
  // Sessions live in Postgres too now (connect-pg-simple auto-creates its own "session"
  // table on first use) — this means logins survive a redeploy the same way the rest of
  // the app's data does, instead of resetting every time the container restarts.
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'edtech-dashboard-local-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hour session
}));

// Make current user AND accurate nav visibility available to every view, on every route —
// not just the dashboard. Without this, pages other than the dashboard were falling back to
// "show the tab unless told not to," which leaked headings for sections a person can't
// actually open. This is computed once per request so nothing has to remember to pass it.
app.use(async (req, res, next) => {
  const user = req.session.user || null;
  res.locals.currentUser = user;
  if (user) {
    const isFacultyOnAnyBatch = !!(await db.prepare('SELECT 1 FROM batches WHERE faculty_id = ? LIMIT 1').get(user.id));
    res.locals.navShowStudents = canViewStudents(user);
    res.locals.navShowFees = canViewFees(user);
    res.locals.navShowBatches = canViewBatches(user) || isFacultyOnAnyBatch;
  }
  next();
});

app.use('/', require('./routes/auth'));
app.use('/students', require('./routes/students'));
app.use('/fees', require('./routes/fees'));
app.use('/users', require('./routes/users'));
app.use('/tasks', require('./routes/tasks'));
app.use('/batches', require('./routes/batches'));
app.use('/courses', require('./routes/courses'));
app.use('/settings', require('./routes/settings'));
app.use('/', require('./routes/invoices'));
app.use('/', require('./routes/receipts'));
app.use('/', require('./routes/enrollments'));

// ---------- DASHBOARD HOME ----------
app.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;

  // Faculty accounts don't get a Dashboard at all — no student or fee data belongs there
  // for them. Send them straight to their batch calendar, or the list if they teach more than one.
  if (isFacultyRole(user)) {
    const myBatches = await db.prepare('SELECT id FROM batches WHERE faculty_id = ?').all(user.id);
    if (myBatches.length === 1) return res.redirect('/batches/' + myBatches[0].id);
    return res.redirect('/batches');
  }

  const scoped = isOwnScopeOnly(user);
  const { from, to, status } = req.query;

  // Two different things get filtered by this one date range, deliberately:
  // - "Who's counted" (Total Students, Total Fee Allocated, the ageing table's rows) is
  //   scoped by the enrollment's Joined Date.
  // - "Fee Collected" is scoped by the date each payment was actually recorded
  //   (fee_collections.collection_date) — NOT by when the student joined.
  // On top of that: a "dropout" enrollment is EXCLUDED from pending-fee totals entirely —
  // it still shows up in the ageing table (for record-keeping) but doesn't drag down
  // "how much is still owed" once someone isn't actually continuing.
  const statusFilter = status === 'dropout' ? "e.status = 'dropout'" : status === 'all' ? '1=1' : "e.status = 'active'";

  const conditions = [statusFilter];
  if (scoped) conditions.push('e.sales_staff_id = @uid');
  if (from) conditions.push('e.joined_date >= @from');
  if (to) conditions.push('e.joined_date <= @to');
  const whereClause = 'WHERE ' + conditions.join(' AND ');
  const bindParams = { uid: user.id, from: from || '', to: to || '' };

  const collectedConditions = [statusFilter.replace('e.', 'e2.')];
  if (scoped) collectedConditions.push('e2.sales_staff_id = @uid');
  if (from) collectedConditions.push('f.collection_date >= @from');
  if (to) collectedConditions.push('f.collection_date <= @to');
  const collectedWhereClause = 'WHERE ' + collectedConditions.join(' AND ');

  // ---- Summary stat cards ----
  const summary = await db.prepare(`
    SELECT COUNT(*) AS student_count, COALESCE(SUM(e.total_fee), 0) AS total_fee
    FROM enrollments e
    ${whereClause}
  `).get(bindParams);

  summary.total_collected = (await db.prepare(`
    SELECT COALESCE(SUM(f.amount), 0) AS total_collected
    FROM fee_collections f
    JOIN enrollments e2 ON e2.id = f.enrollment_id
    ${collectedWhereClause}
  `).get(bindParams)).total_collected;

  summary.total_pending = summary.total_fee - summary.total_collected;
  summary.pending_percentage = summary.total_fee > 0
    ? Math.round((summary.total_pending / summary.total_fee) * 1000) / 10
    : 0;

  // ---- Collection ageing: per-enrollment due days & due percentage ----
  const collectionAgeing = await db.prepare(`
    SELECT e.id, p.person_code AS student_code, p.name, e.course, e.status,
      (SELECT STRING_AGG(b.name, ', ') FROM enrollment_batches eb JOIN batches b ON b.id = eb.batch_id WHERE eb.enrollment_id = e.id) AS batch_name,
      e.total_fee,
      COALESCE(f.total_collected, 0) AS fee_collected,
      (e.total_fee - COALESCE(f.total_collected, 0)) AS pending_fee,
      e.joined_date,
      CASE WHEN e.joined_date IS NOT NULL AND e.joined_date != ''
        THEN (CURRENT_DATE - e.joined_date::date)
        ELSE NULL END AS due_days
    FROM enrollments e
    JOIN persons p ON p.id = e.person_id
    LEFT JOIN (SELECT enrollment_id, SUM(amount) AS total_collected FROM fee_collections GROUP BY enrollment_id) f
      ON f.enrollment_id = e.id
    ${whereClause}
    ORDER BY due_days DESC NULLS LAST
  `).all(bindParams);

  collectionAgeing.forEach(row => {
    row.due_percentage = row.total_fee > 0
      ? Math.round((row.pending_fee / row.total_fee) * 1000) / 10
      : 0;
  });

  // ---- Sales Team performance (admin only) ----
  let staffLeaderboard = [];
  if (user.role === 'admin') {
    const staffConditions = [statusFilter];
    if (from) staffConditions.push('e.joined_date >= @from');
    if (to) staffConditions.push('e.joined_date <= @to');
    const staffJoinClause = 'AND ' + staffConditions.join(' AND ');

    staffLeaderboard = await db.prepare(`
      SELECT u.id, u.name, COUNT(e.id) AS student_count, COALESCE(SUM(e.total_fee), 0) AS total_fee
      FROM users u
      LEFT JOIN enrollments e ON e.sales_staff_id = u.id ${staffJoinClause}
      WHERE u.role = 'sales_staff'
      GROUP BY u.id
      ORDER BY total_fee DESC
    `).all({ from: from || '', to: to || '' });

    const staffCollectedConditions = [statusFilter.replace('e.', 'e2.')];
    if (from) staffCollectedConditions.push('f.collection_date >= @from');
    if (to) staffCollectedConditions.push('f.collection_date <= @to');
    const staffCollectedClause = 'AND ' + staffCollectedConditions.join(' AND ');
    const staffCollectedStmt = db.prepare(`
      SELECT COALESCE(SUM(f.amount), 0) AS total_collected
      FROM fee_collections f
      JOIN enrollments e2 ON e2.id = f.enrollment_id
      WHERE e2.sales_staff_id = @staffId ${staffCollectedClause}
    `);

    for (const r of staffLeaderboard) {
      r.total_collected = (await staffCollectedStmt.get({ staffId: r.id, from: from || '', to: to || '' })).total_collected;
      r.pending = r.total_fee - r.total_collected;
      r.due_percentage = r.total_fee > 0 ? Math.round((r.pending / r.total_fee) * 1000) / 10 : 0;
    }
  }

  res.render('dashboard', {
    user, summary, collectionAgeing, staffLeaderboard,
    filters: { from: from || '', to: to || '', status: status || 'active' },
    canViewStudents: canViewStudents(user),
    canViewFees: canViewFees(user),
    feePerms: getFeePerms(user),
  });
});

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.', user: req.session.user });
});

(async () => {
  try {
    await initSchema();
    app.listen(PORT, () => {
      console.log(`\nEdTech Dashboard running at http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('Failed to start: could not initialize the database.', err.message);
    process.exit(1);
  }
})();
