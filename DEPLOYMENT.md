# Hosting this online — Supabase + Render (free, no credit card)

This app now runs on **Supabase** (a free hosted Postgres database, plus file storage for
your logo/QR code) and **Render** (free web hosting). Neither requires a credit card. The
one thing worth knowing upfront: Supabase's free tier pauses a project after **7 days with
no activity** — Step 6 below shows a free way to prevent that if it matters for you.

Everything the app needs to talk to Postgres and Supabase Storage is already built in —
these steps are entirely about creating accounts and setting configuration, not code.

---

## Step 1 — Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up (no card required).
2. Click **New Project**. Pick any name (e.g. `empowerlearn`), set a **database password**
   (write it down — you'll need it in Step 2), and pick a region close to your users
   (e.g. Mumbai/Singapore for India).
3. Wait a minute or two for the project to finish setting up.

## Step 2 — Get your database connection string

1. In your Supabase project, go to **Project Settings → Database**.
2. Under **Connection string**, select the **Transaction** pooler mode, and copy the URI.
   It looks like:
   ```
   postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-xxxxx.pooler.supabase.com:6543/postgres
   ```
3. Replace `[YOUR-PASSWORD]` with the database password from Step 1.
4. Add `?sslmode=require` to the end if it isn't already there.
5. Keep this whole string somewhere safe — this is your `DATABASE_URL`.

## Step 3 — Create a Storage bucket (for your logo & QR code)

1. In Supabase, go to **Storage** in the left sidebar.
2. Click **New bucket**, name it `uploads`, and toggle it **Public** (so the logo/QR code
   can be shown on invoices without needing a login).
3. Go to **Project Settings → API**. Copy the **Project URL** (this is your `SUPABASE_URL`)
   and the **service_role** key (this is your `SUPABASE_SERVICE_KEY` — not the "anon" key,
   the service_role one; it's below it on the same page, and Supabase shows a warning that
   it's sensitive — that's expected, it's meant to be used only by your own server, never
   exposed in a browser).

## Step 4 — Push this project to GitHub

Render deploys from a GitHub repository, so this project needs to be on GitHub first.

1. Create a new repository on [github.com](https://github.com) (can be private).
2. From this project folder:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```

## Step 5 — Deploy to Render

1. Go to [render.com](https://render.com) and sign up (no card required for the free tier).
2. Click **New → Web Service**, and connect the GitHub repository from Step 4.
3. Render should auto-detect it as a Node app. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. Under **Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the connection string from Step 2 |
   | `SESSION_SECRET` | any long random string |
   | `SUPABASE_URL` | from Step 3 |
   | `SUPABASE_SERVICE_KEY` | from Step 3 |
   | `SUPABASE_STORAGE_BUCKET` | `uploads` |

5. Click **Create Web Service**. Render will build and start the app — watch the logs; you
   should see `Database schema ready.` and `EdTech Dashboard running at ...`. That means
   the app successfully created all its tables in your Supabase database on first boot.
6. Once live, open the URL Render gives you, log in with `admin` / `admin123`, and **change
   that password immediately** (Change Password page, once logged in).

**To push future changes**: commit and `git push` — Render automatically redeploys on every
push to the branch you connected. Your data isn't touched by a redeploy, since it lives in
Supabase, not in the Render container.

## Step 6 — (Optional) Keep the Supabase project from pausing

Only needed if the app might go a full week without anyone opening it (e.g. over a long
break). A free, simple fix: a scheduled ping every few days.

1. In your GitHub repo, create `.github/workflows/keep-alive.yml`:
   ```yaml
   name: Keep Supabase awake
   on:
     schedule:
       - cron: '0 6 */3 * *'  # every 3 days
   jobs:
     ping:
       runs-on: ubuntu-latest
       steps:
         - run: curl -s "https://YOUR-APP.onrender.com/login" || true
   ```
2. Commit and push it. GitHub Actions will now visit your app's login page every 3 days,
   which keeps both Render and Supabase from going idle.

---

## After you're live

- **Change the admin password immediately** (see Step 5.6).
- **Back up your data anyway.** Supabase's free tier doesn't include automated backups —
  from the Supabase dashboard, **Database → Backups** shows manual backup/export options,
  and it's worth doing this occasionally, the same way Section 13 in the main README
  recommends for a local install.
- **This app was built for a small trusted team, not the public internet** — there's no
  rate limiting, and it assumes people behind the login are trusted. Don't advertise the
  URL beyond the people who should have accounts.
- **If you outgrow the free tiers** (500MB database, 1GB file storage on Supabase; Render's
  free instance sleeping after inactivity), both platforms have paid tiers that lift these
  limits without requiring any further changes to this app.

## Local development

Nothing about local development changes much — you still need a `DATABASE_URL` pointing at
*some* Postgres database. Easiest options:
- Point it at your Supabase project directly (same `DATABASE_URL` as production).
- Or run Postgres locally (e.g. via Docker: `docker run -e POSTGRES_PASSWORD=devpass -p 5432:5432 postgres:16`) and use `postgresql://postgres:devpass@localhost:5432/postgres` — no `sslmode=require` needed for a local instance.

Copy `.env.example` to `.env`, fill in `DATABASE_URL` (and the Supabase Storage variables if
you want to test uploads against real Storage), then `npm install && npm start` as usual.
