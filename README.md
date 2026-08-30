# 3AP Video Downloader — Standalone Production Package

This folder is a **100% self-contained, compiled release** of 3AP Video Downloader.
It contains **NO source code (.ts files)**, **NO development configurations**, and **NO Git history**.

---

## 🚀 How to Initialize Git & Push to Public/Private Web

You can treat this directory as a brand new, clean repository:

```bash
# 1. Navigate into this directory
cd deploy-production

# 2. Initialize a fresh Git repository
git init

# 3. Add all compiled production files
git add .

# 4. Commit the production release
git commit -m "Production release v1.0.0"

# 5. Connect to your GitHub / Hosting remote repository
git remote add origin https://github.com/YOUR_USERNAME/YOUR_PROD_REPO.git

# 6. Push ONLY the compiled application to GitHub / Web
git push -u origin main
```

---

## 🛠️ How to Run in Production

### Option 1: VPS / Direct Node.js Host
1. Install production dependencies:
   ```bash
   npm install --omit=dev
   ```
2. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   *(Edit `.env` to set your `WEB_ORIGINS`, secrets, etc.)*

3. (Optional) Run database migrations:
   ```bash
   npm run migrate
   ```

4. Start the application:
   - **API Backend**: `npm run start:api` (or `node apps/api/dist/main.js`)
   - **Worker Service**: `npm run start:worker` (or `node apps/worker/dist/main.js`)
   - **Frontend Static Files**: Located in `public/` and `apps/web/dist/` (serve using Nginx, Netlify, Vercel, or static web host).

### Option 2: Windows Quick Test
Double-click `start-api.bat` to verify the backend server locally.

---

## 🔒 Security Audit Notice
- All TypeScript source files (`.ts`, `.tsx`) have been purged.
- All source maps (`.map`) have been removed.
- All development tools, tests, and configuration files have been stripped.
