# Empower Learn — Student & Fee Collection Dashboard

A Node.js dashboard for tracking student admissions and fee collection, built exactly around the workflow you described:

- **Student Master Data** — one record per admitted student, owned by the Sales Team who admitted them.
- **Fee Collection Details** — a separate, linked table. Every payment is logged with a date and the staff who collected it.
- **Fee Collected** and **Fee Pending** are never typed in manually — they're calculated live from the Fee Collection entries and shown back on the Student Master record automatically, so the two sheets can never fall out of sync.
- **Role-based logins**: Admin (sees everything), Sales Team (sees only the students they personally admitted), and Staff (custom read/write access per module, set by the Admin).

---

## 1. Requirements

- [Node.js](https://nodejs.org) version 18 or later.
- A **Postgres database** to connect to. This app is built for [Supabase](https://supabase.com) (a free, hosted Postgres) — see `DEPLOYMENT.md` for the full step-by-step setup, including free hosting for the app itself. A local Postgres instance also works for development; the app doesn't care which, as long as `DATABASE_URL` points at a real one.

## 2. First-time setup

> **Already running an earlier version of this dashboard (the local SQLite one)?** This version is a genuinely different backend — Postgres instead of a local SQLite file — so it's not a drop-in swap the way past updates were. See `DEPLOYMENT.md` for how to set up a Supabase database, and get in touch if you'd like help moving your existing data across; it isn't done automatically by starting the new version.

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL` (see `DEPLOYMENT.md` Steps 1–2 for getting one from Supabase, or point it at a local Postgres instance for development).
2. Open a terminal / command prompt in this folder and run:

```bash
npm install
npm start
```

You should see:

```
Database schema ready.
Seeded default admin user -> username: admin | password: admin123
EdTech Dashboard running at http://localhost:4500
```

Open **http://localhost:4500** in a browser.

> This dashboard runs on port **4500** by default (set in the `.env` file) — chosen to stay clear of common ports like 3000, 5000, or 8080 that other local apps often use. If you ever get a "port already in use" error, open `.env` and change `PORT=4500` to any other free number, e.g. `PORT=4501`. On a hosted platform like Render, the platform sets `PORT` for you automatically.

Log in with:
- **Username:** `admin`
- **Password:** `admin123`

**Change this password immediately** (top-right → *Password*), then go to **Staff & Access** to create real accounts for your team.

To stop the server, go back to the terminal and press `Ctrl + C`. To start it again later, just run `npm start` from this folder — all your data lives in your Postgres database, not on this computer, so it's untouched either way.

## 3. How the access rights work

| Role | What they see | What they can edit |
|---|---|---|
| **Admin** | Every student, every fee entry, all staff accounts, every batch | Everything, including creating/disabling staff logins, setting access rights, and Company Settings |
| **Sales Team** | Only the students *they* admitted, plus every batch calendar (to copy Zoom links), plus Invoices &amp; Receipt Vouchers for their own students | Full add/edit rights for their own students, fee entries, and Invoices/Receipt Vouchers; batch editing only if separately granted |
| **Staff** | Configurable, field by field (see below) | Configurable, field by field |
| **Faculty** | Only the batch calendar(s) they're assigned to teach — nothing else | Nothing — view only, always (see below) |

**Faculty is a fixed, no-configuration role** — there are no checkboxes to set for a Faculty account, because their access is entirely determined by which batch(es) they've been assigned to teach. A Faculty account:
- Has **no Dashboard** — logging in takes them straight to their batch's calendar (or a short list, if they teach more than one)
- Never sees Student Master Data or Fee Collection, under any circumstance
- Can see their batch's schedule (Working/Leave/Holiday days), Class Completed / Recording Uploaded status, and copy Zoom links — but can't edit or mark any of it. All of this is strictly view-only, including for their own assigned batch; only Admin or a Staff/Sales Team account with Batch Edit rights can actually mark a class as done or a recording as uploaded.
- Only sees batches where **they specifically** are set as Faculty — if two faculty members each teach a different batch, neither sees the other's calendar

To assign someone as Faculty for a batch: create their account with Role = **Faculty** under Staff & Access, then open that batch (or create a new one) and pick them from the **Faculty** dropdown.

**Staff accounts get field-level control**, not just a single "can they see fees" switch. Under **Staff & Access → Add/Edit account**, for any Staff role you set:

- **Student Master Data**: View / Edit (name, contact details, batch, job details, etc. — everything except the fee figures below)
- **Fee (Total Fee Allocated)**: View / Edit
- **Fee Collected**: View / Edit *(Edit here means "can record new payments and remove entries")*
- **Fee Due (Pending)**: View only — it's always calculated as Fee − Fee Collected, so there's nothing separate to edit
- **Fee Due Ageing (Days)**: View only — calculated from the student's Joined Date to today
- **Fee Due Percentage**: View only — calculated as Fee Due ÷ Fee × 100
- **Invoices & Receipt Vouchers**: View / Edit — for a **Staff** account, Edit means full power: create, edit, and delete. **Sales Team accounts work differently on purpose**: they automatically get View plus the ability to **create** a new invoice or generate a receipt for their own students — but they can never edit or delete one afterward, even one they created themselves. Only Admin, or a Staff account with this Edit checkbox, can change or remove an existing invoice/receipt.

A Staff account only sees the stat cards, table columns, and buttons for the fields they've been granted — everything else is hidden, not just greyed out. These checks are also enforced on the server, not just in the interface, so a Staff account can't bypass a view-only restriction by editing the page or resubmitting a form manually. The navigation itself follows the same rule on every page, not just the Dashboard — an account with no Fee access, for example, never sees a "Fee Collection" tab anywhere in the app, not even on pages unrelated to fees.

Each account (any role) can also be given a free-text **Job Role / Designation** (e.g. "Accounts Executive", "Counselor", "Physics Faculty") — shown next to their name in the top navigation. This is separate from their system Role (Admin / Sales Team / Staff / Faculty), which controls what they can actually do.

Note: Staff accounts see records across *all* Sales Team — the permission checkboxes control which fields they can see/edit, not which individual students. Only the **Sales Team** role is automatically restricted to "my own students only."

## 4. Tasks — assigning and tracking duties

Beyond fee collection, day-to-day work often includes duties that aren't about money at all — adding students to a batch's WhatsApp group, collecting ID proof, following up on documents, and so on. The **Tasks** tab covers this:

- **Admin creates and assigns tasks** — each task is assigned to exactly one staff member (any role: Admin, Sales Team, or Staff).
- **Every task is one of three types**:
  - **Not student-related** — a single one-off duty (e.g. "Prepare welcome kits for July batch"). Tracked as one Pending/Done status.
  - **Whole batch** — applies to every student currently in a chosen batch, tracked **per student**. If a new student joins that batch later, they automatically show up on the task too — nothing needs to be re-created.
  - **Specific students** — a hand-picked list you select when creating the task, tracked per student, fixed to exactly those students regardless of batch changes afterward.
- **Visibility is strictly per-assignee** — everyone (including Sales Team and other Staff accounts) only ever sees tasks assigned to *them* under the Tasks tab. Admin is the only one who sees every task across the institution, for oversight.
- Each task shows a progress badge (e.g. "3 / 8 done") so it's easy to see what's outstanding at a glance, both in the task list and on the task's own page.

This is fully separate from the Fee permission system — assigning someone a task doesn't grant them any extra access to fee or student data, and vice versa.

## 5. Admission Leads — the pipeline before someone becomes a student

This replaces tracking WhatsApp/call enquiries in a separate Excel or Google Sheet. A **Lead** captures someone who's shown interest but hasn't (yet) enrolled: Date of Lead, Phone, Name, Course Looking For, Place, Job, Remarks, Last Chat Notes, and Status.

- **Access matches Student Master Data exactly**: Admin sees every lead; Sales Team automatically has full access to their own leads only; Staff access is configurable under Staff & Access ("Admission Leads" row); Faculty has none.
- **Status is free-form and shared** — anyone who can edit leads (including Sales Team, no special permission needed) can type a new status straight into the form via "Other," and it immediately becomes available in everyone's dropdown from then on. Two statuses always exist no matter what: **New** (the default for a freshly added lead) and **Joined** (see below).
- **Filter by anything**: the Leads list can be filtered by search (name/phone), lead date range, course, status, place, job, and — for Admin/Staff — Sales Team member, all at once.
- **Export** works the same way as everywhere else in this app — an Excel download respecting whatever filters are currently applied.

**Converting a lead into an admission**: open the lead and click **Convert to Admission**. This doesn't duplicate any work — it takes you straight into the same "Add Student" (or "Add another course," if that phone number already belongs to an existing student) form used everywhere else in this app, with Name, Phone, and Course already filled in from the lead. Complete the remaining details (Batch, Fee, Joined Date) and save as normal. The moment that admission is created, the lead automatically flips to **Joined** status and shows a link back to the new enrollment — nothing needs to be updated by hand on the lead's side afterward.

## 6. Person & Enrollment — one Student ID, any number of courses

**Every student has exactly one Student ID for life, no matter how many courses they take.** Their name, phone, email, and other personal details live in one place (their **Person** profile); each course they enroll in — with its own batch, fee, Sales Team credit, joined date, and fee/invoice/receipt history — is a separate **Enrollment** underneath that same profile.

- **Adding a student for the first time** (Students → Add Student) creates their Person profile and their first Enrollment together, in one form, exactly as before.
- **When that same person comes back for a second course**, open their profile and use **"+ Add another course"** — this does *not* create a new Student ID or a duplicate record. It adds a second Enrollment under their existing profile, so their old course's fee history stays completely separate from the new one.
- **A student's profile page** now shows their contact details once, plus a list of every course they've enrolled in — click any course to open that specific Enrollment, where its fee collection, invoices, and receipts live.
- **Fee, invoice, and receipt records always belong to one specific Enrollment**, never to the person generally — recording a payment for their Web Development course has zero effect on their Data Analytics course's numbers, even though it's the same person.
- **Import** recognizes this too: uploading a row with a Student ID that already exists adds a new course for that person instead of creating a duplicate profile — see Section 10.

**One Enrollment can be scheduled into more than one Batch.** If a student attends two sessions of the *same* course (e.g. a morning batch and an evening batch), that's still just **one** Enrollment, one fee, one invoice/receipt history — you just tick more than one batch when adding or editing that enrollment. This is different from taking a second course: same course + extra batch = tick another box on the same enrollment; a genuinely different course = "+ Add another course" (a whole new Enrollment). Tasks and attendance-style features scoped to "a batch" pick up a student correctly regardless of which of their batches matches.

**Dropout status**: each Enrollment (not the whole person) can be marked **Active** or **Dropout** — from that course's page, or from its edit form. A Dropout enrollment:
- Is excluded from the Dashboard's pending-fee totals and the Students list's fee summary, so it doesn't inflate "how much is actually still owed."
- Keeps its full fee/invoice/receipt history intact and visible — nothing is deleted, it's just excluded from active totals.
- Still shows up if you explicitly filter for it (Dashboard's Status filter, or the Students list's Status filter).

## 7. How the linking works

1. A Sales Team (or Admin) adds a student in **Students → Add Student**, filling in their details, course, batch, and the **Total Fee Allocated**. This creates their Person profile and first Enrollment together.
2. Whenever a payment comes in, open that specific course's Enrollment page and use **Record fee collection** on the right-hand side — enter the amount and the date collected.
3. That entry is saved in the separate Fee Collection table, linked to that Enrollment specifically.
4. That Enrollment's **Fee Collected** and **Fee Pending** figures — on its own page, on the Students list, and on the Dashboard — update immediately, because they're calculated as:
   - `Fee Collected = sum of all fee collection entries for this Enrollment`
   - `Fee Pending = Total Fee Allocated − Fee Collected`

The consolidated **Fee Collection** tab in the navigation shows every payment across every enrollment (filterable by date), while still respecting each user's access rights.

## 8. Dashboard: collection ageing & staff performance

The home Dashboard now includes:

- **Summary cards**: Total Students, Total Fee Allocated, Total Fee Collected, Fee Pending, and Fee Pending %.
- **Collection ageing table**: Student ID, Name, Course, Status, Batch, Fee, Collected, Pending, Due %, and Due Days — one row per Enrollment (so a person with two courses shows up as two rows, one per course), where Due Days is the number of days from that enrollment's **Joined Date** to today, and Due % is `Pending ÷ Fee × 100`. These per-enrollment figures are always all-time totals, not limited by the date filter below.
- **Sales Team performance** (Admin only): Staff Name, No. of Students, Fee Allocated, Fee Collected, Fee Due, and Due % — aggregated per staff member.
- **Status filter**: defaults to **Active only**, meaning Dropout enrollments are excluded from every total on this page. Switch to "Dropout only" or "Active + Dropout" to see them.
- **Date filter — two different things, on purpose**: the "Joined from / Joined to" filter scopes **Total Students** and **Total Fee Allocated** by the enrollment's **Joined Date** (which enrollments are counted), but scopes **Fee Collected** by the date each payment was actually recorded (**Fee Collection date**) — not by when the student joined. This means a payment made this week for a student who joined months ago still counts as "collected" this week, which is what most people mean by "date-wise collection." One side effect worth knowing: because these two are scoped differently, **Fee Due** in a filtered view can show a negative number (e.g. if a lot of money came in during a window where few new enrollments were made) — that's expected, not a bug. Leave both dates blank to see all-time figures everywhere.

Sales Team only ever see their own students in these views; Admin sees the whole institution.

## 9. Student Master Data fields

**Person profile** (shared across all their courses): Student ID (auto-generated, e.g. `STU0001`), Name, Phone No. (WhatsApp), Phone No. (Call), Mail ID, Location, District, State, Pincode, Job Role, Job/Business Name, Job Location.

**Per-course Enrollment fields**: Sales Team, Student Batch (selected from the Batches list), **Course**, Status (Active/Dropout), Joined Date, Total Fee Allocated, Fee Collected *(auto)*, Fee Pending *(auto)*, Remarks.

**Course is mandatory and managed like Batches** — pick from the dropdown (managed under **Students → Courses**), or choose **Other** to type a course name on the spot if it's not listed yet. **Nothing is pre-filled** — a brand new install starts with zero courses; the list only ever grows when someone with actual access adds to it. Whether a typed "Other" name joins the shared dropdown for everyone else depends on permissions:
- **Admin** can always add courses, either from the Courses page or by typing "Other" on an enrollment — this is also how the very first course gets created on a new install.
- **Staff / Sales Team** can only add to the shared list if granted **"Course list (add new courses)"** under Staff & Access. Without it, typing "Other" still saves that course on the enrollment being entered — it just won't appear in others' dropdowns until an Admin (or someone with that permission) formally adds it via the Courses page.

**Picking a deleted Batch or Course is explicitly rejected**, not silently ignored — if a stale page still shows a Batch that's since been deleted (e.g. a tab left open), submitting it gives a clear error asking you to pick a current one, rather than quietly saving the enrollment without that batch attached.

## 10. Importing & exporting Student Master Data

- **Export** (Students → Export): downloads an .xlsx of whatever's currently filtered on the Students page — respects your search/batch/course/staff filters, and only includes the fee columns you actually have permission to see.
- **Import** (Students → Import, requires edit rights): upload an .xlsx with the same columns as the export. A row with a **Student ID** that matches an existing record **updates** that student; a row with no Student ID (or one that doesn't match) **creates** a new one. Required columns: Student ID (can be blank), Name, Sales Team (must match an existing account name), Joined Date (YYYY-MM-DD). Everything else is optional. After importing, you'll see exactly how many rows were created, updated, or skipped — and why, for anything skipped (e.g. a Sales Team name that didn't match any account).
- The easiest way to build an import file correctly is to export first, edit that file, and re-upload it.

## 11. Fee Collection — date-wise export

The Fee Collection ledger (Fee Collection tab) has its own **Export** button, right next to the date filter. It exports exactly what's currently on screen — so setting a From/To range and then exporting gives you a clean, complete, date-wise record of every payment in that window: Collection Date, Student ID, Student Name, Batch, Amount Collected, Collected By, Notes, and a Total row at the bottom. Leave the dates blank to export the complete all-time ledger instead.

## 12. Invoices & Receipt Vouchers (PDF)

Every student's page now has two sections for generating real PDF documents:

- **Invoices** — billing documents for a student's fee. Create one from the student's page (pre-filled with their Total Fee and their selected **Course** as the description, but everything is editable). A student can have more than one invoice, useful for installment-wise billing. Each gets a sequential number (`INV-0001`, `INV-0002`, ...).
- **Receipt Vouchers** — official receipts for money already received. Rather than filling in a separate form, click **Generate** next to any entry in a student's Fee Collection history and it creates a receipt voucher (`RCT-0001`, ...) with a description of "Fee payment - [Course]", pulling the amount, date, and notes straight from that payment record — then you can fine-tune it (e.g. add the payment mode) before downloading.

Both are viewable, downloadable as PDF, and — for Admin and permitted Staff — editable/deletable, all governed by the same access rights as the rest of a student's record (see Section 3). **Sales Team can create an invoice or generate a receipt, and view/download it afterward, but can never edit or delete one** — that's deliberately reserved for Admin and Staff with Edit rights. Both PDFs include the amount spelled out in words (e.g. "Rupees Fifty Thousand Only"), which is standard practice on Indian invoices and receipts.

**Invoices include Bank Details and a QR code**, both centrally set once under **Settings**. For the QR code, you have two options:
- **Upload your own QR code image** (PNG/JPG) — e.g. the exact QR your bank gave you for your account. This is used as-is on every invoice.
- **Or set a UPI ID instead** — if no QR image is uploaded, every invoice automatically gets an auto-generated QR code scoped to that invoice's exact amount, so scanning it in GPay, PhonePe, Paytm, or any UPI app pre-fills the amount. If both are set, the uploaded image takes priority.

Receipt Vouchers deliberately don't show bank details or a QR code, since they're for money already received, not money still owed.

**The PDF is generated on the server**, not by a browser's print function — so opening the same invoice on a computer and on a phone produces byte-for-byte the same document. There's no "it looks different on mobile" problem, because the phone is just downloading a file, not rendering a webpage into a PDF itself.

**Company branding is centrally editable** under **Settings** (Admin only): upload your logo and QR code (PNG/JPG), set your address, phone, email, GSTIN, bank details, and UPI ID, and write separate Terms & Conditions text for Invoices and for Receipt Vouchers. Every PDF generated afterward picks these up automatically — change your terms once, and every invoice from then on reflects it. (Existing PDFs already downloaded are obviously unaffected, since a PDF is a fixed snapshot at the moment it was generated.) The document title (e.g. "INVOICE" or "RECEIPT VOUCHER") always sits on its own line at the very top of the page, so it's never at risk of overlapping the company name regardless of how long the title text is.

## 13. Batches — schedules, Zoom links, and faculty

A student's Batch is no longer just a label — it's created first under the **Batches** tab, and students then pick from that list.

- **Create a batch** with a name, start date, end date, and (optionally) the faculty teaching it. Every calendar day in that date range is automatically set to **Working** — you only need to touch the days that are different.
- **Open a batch to see its calendar** (month view, with Prev/Next navigation). **Today's date is always highlighted** with a bold outline and a small "Today" tag, so it's immediately obvious at a glance regardless of its Working/Leave/Holiday color. Click any day to set its status, paste a **Zoom link** for that session, and add a short note. Each day is one of three statuses, each shown in its own color:
  - **Working** (green) — class is on, the default for every day in range
  - **Leave** (red) — no class today, specific to this batch (e.g. faculty unavailable)
  - **Holiday** (amber) — an institution-wide day off (e.g. a public holiday or festival)
  - A Leave or Holiday day has no class, so it can't have a Zoom link — the field is automatically disabled and cleared for those two statuses, both in the form and on the server, so a link from a day that later gets marked Leave/Holiday doesn't linger.
- **Faculty is a dedicated role, not free text** — when creating or editing a batch, pick the Faculty from a dropdown of accounts with the **Faculty** role. Whoever is selected automatically sees only that batch's calendar — see Section 3 above for exactly what a Faculty account can and can't do.
- **Sales Team automatically get View access** to every batch calendar, specifically to find and copy Zoom links for sharing — no permission needs to be granted for this, it comes with the role. **Edit** is still optional and admin-granted, for both Sales Team and Staff, under **Staff & Access → Batch Calendar access**. Edit lets an account create batches, change the schedule, and add/change links.
- **Extending a batch's end date** automatically adds Working days for the newly covered dates — nothing already recorded (Leave/Holiday days, links, notes) is touched.
- **Class completed & recording uploaded** — for any Working day, once the class has actually happened, whoever's responsible marks it **"Class done"**. If it was recorded, they separately mark **"Recording uploaded"** — these are two independent checks, not one, since a class can easily be done with the recording still pending. A day shows one of three looks: plain green (Working, not yet done), amber-red (class done, recording still pending — worth checking on), or teal (both done). The batch calendar has a color legend at the top so this is easy to read at a glance. **Marking these is restricted to Admin or a Staff/Sales Team account with Batch Edit rights** — Faculty can see this status on their own batch calendar, exactly like everything else there, but can't mark or change it.
- **Recording gaps are summarized, not just per-day** — both the individual batch calendar and the main Batches list show **Classes Completed** and **Recording Pending** counts, so it's easy to spot at a glance which batches have classes done but recordings not yet uploaded, without having to click into each one.
- Batches also show up as an option when creating a **Task** scoped to "every student in one batch" (see above) — and the student list, dashboard, and student profile all link back to a batch's calendar wherever its name appears.

## 14. Backing up your data

Your data lives in your Postgres database (Supabase, or wherever `DATABASE_URL` points), not on the computer running the app — so there's no local file to copy. To back up:

- **From Supabase**: **Database → Backups** in the dashboard offers manual backup/export options on the free tier (automated daily backups are a paid-tier feature). Doing a manual export occasionally is worth it.
- **Using `pg_dump`** (works against any Postgres, including Supabase), if you have it installed: `pg_dump "$DATABASE_URL" > backup.sql` saves everything to a single file you can restore later with `psql "$DATABASE_URL" < backup.sql`.
- **Uploaded logo/QR code**: if using Supabase Storage, these live in your `uploads` bucket and are covered by the same Supabase backup options above.

To start fresh with an empty database, either create a new Supabase project and point `DATABASE_URL` at it, or manually drop all the tables in your existing one — the app recreates its full schema and a default admin account automatically the next time it starts against an empty database.

## 15. Running this on a shared office computer / small network

If you're running the app itself locally (with `DATABASE_URL` pointing at Supabase or a local Postgres) rather than hosting it online, by default the dashboard is only reachable from the same computer (`localhost`). If your sales team needs to reach it from their own computers on the same office network:

1. Find the server computer's local IP address (e.g. `192.168.1.20`).
2. On other computers on the same network, open `http://192.168.1.20:4500` instead of `localhost:4500`.
3. Make sure the server computer's firewall allows incoming connections on port 4500.

This is fine for a small trusted office network. It is **not** set up for exposing the dashboard to the public internet — doing that would need HTTPS and additional security hardening. **For proper hosting reachable from anywhere (not just one office network), see `DEPLOYMENT.md`** — it walks through free hosting on Render, with Supabase as the database, which already includes HTTPS.

## 16. Project structure

```
server.js              Entry point
db/database.js         Postgres schema + default admin seed
middleware/auth.js      Login & access-right checks
routes/                 auth, students, leads, fees, users, tasks, batches, courses, settings, invoices, receipts, enrollments
utils/                  PDF generation (invoices/receipts) and number-to-words conversion
views/                  EJS pages
public/css/style.css    Styling
public/uploads/         Uploaded company logo
```
