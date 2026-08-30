#!/usr/bin/env node
/**
 * Download-engine bootstrap: fetches the official yt-dlp release binary for
 * the current platform into the project-local ./bin directory.
 *
 * Safety properties (docs/22-SECURITY.md):
 *  - official source only: github.com/yt-dlp/yt-dlp releases over HTTPS
 *  - version pinned (change YT_DLP_VERSION deliberately, never implicitly)
 *  - SHA-256 integrity verification against the official SHA2-256SUMS values
 *    embedded below; a mismatch aborts before anything is executed
 *  - controlled install directory (<repo>/bin), never system locations
 *
 * Usage: npm run setup:engine
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.08.19';
const BASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}`;

/** Official SHA2-256SUMS values for the pinned release. */
const CHECKSUMS = {
  'yt-dlp.exe': '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
  'yt-dlp_linux': '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
  'yt-dlp_macos': '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
};

const ASSET_BY_PLATFORM = {
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux',
  darwin: 'yt-dlp_macos',
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = join(repoRoot, 'bin');
const asset = ASSET_BY_PLATFORM[process.platform];

if (!asset) {
  console.error(JSON.stringify({ event: 'setup_engine_failed', reason: `unsupported platform ${process.platform}; install yt-dlp manually` }));
  process.exit(1);
}

const expectedSha256 = CHECKSUMS[asset];
const destPath = join(binDir, asset);

async function main() {
  // Skip when the exact pinned version is already installed and intact.
  try {
    if (statSync(destPath).size > 0) {
      const existing = createHash('sha256').update(readFileSync(destPath)).digest('hex');
      if (existing === expectedSha256) {
        console.log(JSON.stringify({ event: 'setup_engine_skipped', reason: `${VERSION} already installed`, path: destPath }));
        return;
      }
    }
  } catch {
    /* not installed yet */
  }

  console.log(JSON.stringify({ event: 'setup_engine_start', version: VERSION, asset }));
  const url = `${BASE_URL}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} from ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `integrity check failed for ${asset}: expected ${expectedSha256}, got ${actualSha256}. ` +
        'Refusing to install. The release or your network may be compromised.',
    );
  }

  mkdirSync(binDir, { recursive: true });
  const tmpPath = `${destPath}.download`;
  writeFileSync(tmpPath, buffer, { mode: 0o755 });
  rmSync(destPath, { force: true });
  renameSync(tmpPath, destPath);
  if (process.platform !== 'win32') chmodSync(destPath, 0o755);

  console.log(JSON.stringify({
    event: 'setup_engine_complete',
    version: VERSION,
    path: destPath,
    sha256: actualSha256,
    bytes: buffer.byteLength,
  }));
}

main().catch((err) => {
  rmSync(`${destPath}.download`, { force: true });
  console.error(JSON.stringify({ event: 'setup_engine_failed', message: err.message }));
  process.exit(1);
});
