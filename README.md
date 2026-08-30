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
git remote add origin https://github.com/ayushistop-cloud/AP-Vd-down.git

# 6. Push ONLY the compiled application to GitHub / Web
git push -u origin main --force
```

---

## 🛠️ How to Run in Production (Render / Railway / Vercel / VPS)

### Render / Railway / PaaS Deployment
1. Point your service build command to:
   ```bash
   npm install --omit=dev
   ```
   *(Or leave as default - the root `package.json` has a pre-built `build` script and `postinstall` engine hook)*

2. Set start command:
   - **API Backend**: `node apps/api/dist/main.js` (or `npm start`)
   - **Worker Service**: `node apps/worker/dist/main.js` (or `npm run start:worker`)

### Vercel Static Frontend Deployment
1. Deploy `public/` or `apps/web/dist/` (or set Root Directory to `public/`).
2. Routing & API proxying to Render backend is configured automatically via `vercel.json`.

---

## 🔒 Security Audit Notice
- All TypeScript source files (`.ts`, `.tsx`) have been purged.
- All source maps (`.map`) have been removed.
- All development tools, tests, and configuration files have been stripped.
