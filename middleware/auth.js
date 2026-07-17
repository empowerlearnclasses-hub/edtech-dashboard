// Middleware helpers for authentication + role/permission based access control

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'Admin access only.', user: req.session.user });
  }
  next();
}

// Can this logged-in user VIEW the students module at all?
function canViewStudents(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'sales_staff') return true; // own students only
  if (user.role === 'staff') return !!user.perm_view_students;
  return false;
}

// Can this logged-in user CREATE/EDIT students?
function canEditStudents(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'sales_staff') return true; // own students only
  if (user.role === 'staff') return !!user.perm_edit_students;
  return false;
}

// ---------- Granular fee field permissions ----------
// Admin and Sales Staff always have full fee visibility/edit rights (Sales Staff scoped to their own students).
// Staff accounts get exactly the fields the Admin has ticked for them.
function fieldPerm(user, staffField) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'sales_staff') return true;
  if (user.role === 'staff') return !!user[staffField];
  return false;
}

const canViewFeeAllocated = (user) => fieldPerm(user, 'perm_view_fee_allocated');
const canEditFeeAllocated = (user) => fieldPerm(user, 'perm_edit_fee_allocated');
const canViewFeeCollected = (user) => fieldPerm(user, 'perm_view_fee_collected');
const canEditFeeCollected = (user) => fieldPerm(user, 'perm_edit_fee_collected');
const canViewFeeDue = (user) => fieldPerm(user, 'perm_view_fee_due');
const canViewFeeAgeing = (user) => fieldPerm(user, 'perm_view_fee_ageing');
const canViewFeeDuePercentage = (user) => fieldPerm(user, 'perm_view_fee_due_percentage');

// Bundle of all fee-field permissions, handy to pass straight into views
function getFeePerms(user) {
  return {
    viewAllocated: canViewFeeAllocated(user),
    editAllocated: canEditFeeAllocated(user),
    viewCollected: canViewFeeCollected(user),
    editCollected: canEditFeeCollected(user),
    viewDue: canViewFeeDue(user),
    viewAgeing: canViewFeeAgeing(user),
    viewDuePercentage: canViewFeeDuePercentage(user),
  };
}

// Module-level gate: does this user have access to the Fee Collection area at all
// (nav link, /fees route)? True if they can see or touch any single fee field.
function canViewFees(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  const p = getFeePerms(user);
  return p.viewAllocated || p.viewCollected || p.viewDue || p.viewAgeing || p.viewDuePercentage;
}

// Module-level gate: can this user edit anything fee-related at all
// (used to decide whether to show the "record fee collection" panel etc.)
function canEditFees(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  const p = getFeePerms(user);
  return p.editAllocated || p.editCollected;
}

// Whether the user is restricted to only their OWN students (sales staff scoping)
function isOwnScopeOnly(user) {
  return user.role === 'sales_staff';
}

// Faculty accounts get a deliberately minimal, fixed experience: no Dashboard, no
// Student/Fee access ever (nothing to configure — the role itself decides that), just
// whichever batch calendar(s) they've been assigned to as Faculty.
function isFacultyRole(user) {
  return !!user && user.role === 'faculty';
}

// ---------- Staff task tracking ----------
// Tasks are created/assigned by Admin only. Any user can see and act on a task if
// they're the assignee; Admin can see and act on every task, for oversight.
function canManageTasks(user) {
  return !!user && user.role === 'admin';
}
function canAccessTask(user, task) {
  if (!user || !task) return false;
  return user.role === 'admin' || task.assigned_to === user.id;
}

// ---------- Batch calendar access ----------
// Sales Staff automatically get View — they need to be able to find and copy Zoom links
// to share, the same way they automatically get full access to their own students' fees.
// Edit stays admin-granted for both Sales Staff and Staff. Faculty accounts don't use
// this broad check at all — their access comes only from being assigned to a specific
// batch (see isFacultyOn in routes/batches.js), never a general grant.
function canViewBatches(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  if (user.role === 'staff') return !!user.perm_view_batches;
  return false;
}
function canEditBatches(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'sales_staff' || user.role === 'staff') return !!user.perm_edit_batches;
  return false;
}

function requireViewBatches(req, res, next) {
  if (!canViewBatches(req.session.user)) {
    return res.status(403).render('error', { message: 'You do not have permission to view batch calendars. Ask your Admin to grant Batch access under Staff & Access.', user: req.session.user });
  }
  next();
}
function requireEditBatches(req, res, next) {
  if (!canEditBatches(req.session.user)) {
    return res.status(403).render('error', { message: 'You do not have permission to edit batches. Ask your Admin to grant Batch edit access under Staff & Access.', user: req.session.user });
  }
  next();
}

// ---------- Course list access ----------
// Anyone who can edit students can still PICK from the existing Course list — this only
// controls who can ADD a new course to that shared list (Admin always can).
function canEditCourses(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'sales_staff' || user.role === 'staff') return !!user.perm_edit_courses;
  return false;
}
function requireEditCourses(req, res, next) {
  if (!canEditCourses(req.session.user)) {
    return res.status(403).render('error', { message: 'You do not have permission to add courses. Ask your Admin to grant Course access under Staff & Access.', user: req.session.user });
  }
  next();
}

// ---------- Invoices & Receipt Vouchers ----------
// Three separate tiers, not two:
//  - View:   Admin, Sales Team (own students), Staff with perm_view_invoices.
//  - Create: same as View, but requires the *edit* permission for Staff (creating is part
//            of "editing" as far as that one checkbox goes) — Sales Team CAN create.
//  - Edit/Delete (changing or removing something already created): Admin, or Staff with
//            perm_edit_invoices — Sales Team explicitly CANNOT, by design: they can raise
//            an invoice or receipt, but not alter or remove one afterward.
// Faculty: none, at any tier.
function canViewInvoices(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  if (user.role === 'staff') return !!user.perm_view_invoices;
  return false;
}
function canCreateInvoices(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  if (user.role === 'staff') return !!user.perm_edit_invoices;
  return false;
}
function canEditInvoices(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'staff') return !!user.perm_edit_invoices;
  return false; // Sales Team never gets edit/delete, regardless of ownership
}
// Per-student checks, respecting Sales Team's "own students only" scope.
function canViewInvoicesForStudent(user, student) {
  if (!canViewInvoices(user)) return false;
  if (user.role === 'sales_staff') return student && student.sales_staff_id === user.id;
  return true;
}
function canCreateInvoicesForStudent(user, student) {
  if (!canCreateInvoices(user)) return false;
  if (user.role === 'sales_staff') return student && student.sales_staff_id === user.id;
  return true;
}
function canEditInvoicesForStudent(user, student) {
  if (!canEditInvoices(user)) return false;
  if (user.role === 'sales_staff') return student && student.sales_staff_id === user.id;
  return true;
}

// ---------- Admission Leads ----------
// Same shape as Student Master Data: Admin sees everything, Sales Team sees only their
// own leads (full read/write, automatically), Staff is configurable, Faculty gets none.
function canViewLeads(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  if (user.role === 'staff') return !!user.perm_view_leads;
  return false;
}
function canEditLeads(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'sales_staff') return true;
  if (user.role === 'staff') return !!user.perm_edit_leads;
  return false;
}
function requireViewLeads(req, res, next) {
  if (!canViewLeads(req.session.user)) {
    return res.status(403).render('error', { message: 'You do not have permission to view admission leads.', user: req.session.user });
  }
  next();
}

function requireViewStudents(req, res, next) {
  if (!canViewStudents(req.session.user)) {
    return res.status(403).render('error', { message: 'You do not have permission to view student records.', user: req.session.user });
  }
  next();
}

function requireViewFees(req, res, next) {
  if (!canViewFees(req.session.user)) {
    return res.status(403).render('error', { message: 'You do not have permission to view fee collection records.', user: req.session.user });
  }
  next();
}

module.exports = {
  requireLogin,
  requireAdmin,
  canViewStudents,
  canEditStudents,
  canViewFees,
  canEditFees,
  canViewFeeAllocated,
  canEditFeeAllocated,
  canViewFeeCollected,
  canEditFeeCollected,
  canViewFeeDue,
  canViewFeeAgeing,
  canViewFeeDuePercentage,
  getFeePerms,
  isOwnScopeOnly,
  isFacultyRole,
  canManageTasks,
  canAccessTask,
  canViewBatches,
  canEditBatches,
  requireViewBatches,
  requireEditBatches,
  canViewInvoices,
  canCreateInvoices,
  canEditInvoices,
  canViewInvoicesForStudent,
  canCreateInvoicesForStudent,
  canEditInvoicesForStudent,
  canViewLeads,
  canEditLeads,
  requireViewLeads,
  canEditCourses,
  requireEditCourses,
  requireViewStudents,
  requireViewFees,
};
