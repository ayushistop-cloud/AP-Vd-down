#!/usr/bin/env node
/**
 * Download-engine bootstrap: fetches the official latest stable yt-dlp release binary
 * for the target platform into the project-local ./bin directory.
 *
 * Safety properties (docs/22-SECURITY.md):
 *  - official source only: github.com/yt-dlp/yt-dlp releases over HTTPS
 *  - dynamic version query with fallback to pinned stable release
 *  - SHA-256 integrity verification against official SHA2-256SUMS
 *  - controlled install directory (<repo>/bin), never system locations
 *
 * Usage: npm run setup:engine
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '2026.08.19';

/** Pinned SHA2-256SUMS values for fallback release. */
const FALLBACK_CHECKSUMS = {
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

/** Parse SHA2-256SUMS text file into asset -> sha256 map. */
function parseChecksumsText(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const sha = parts[0];
      const filename = parts[1].replace(/^\*/, '').trim();
      if (sha && filename) {
        map[filename] = sha;
      }
    }
  }
  return map;
}

/** Fetch latest release info and checksums from GitHub. */
async function resolveReleaseInfo() {
  try {
    const apiRes = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { 'User-Agent': '3AP-Video-Downloader/1.0' },
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      const version = data.tag_name;
      if (version && typeof version === 'string') {
        const sumsUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/SHA2-256SUMS`;
        const sumsRes = await fetch(sumsUrl);
        if (sumsRes.ok) {
          const sumsText = await sumsRes.text();
          const checksums = parseChecksumsText(sumsText);
          if (Object.keys(checksums).length > 0) {
            return { version, checksums, baseUrl: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}` };
          }
        }
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: 'setup_engine_latest_check_warning', message: err.message }));
  }

  return {
    version: FALLBACK_VERSION,
    checksums: FALLBACK_CHECKSUMS,
    baseUrl: `https://github.com/yt-dlp/yt-dlp/releases/download/${FALLBACK_VERSION}`,
  };
}

async function downloadAsset(assetName, releaseInfo) {
  mkdirSync(binDir, { recursive: true });
  const { version, checksums, baseUrl } = releaseInfo;
  const expectedSha256 = checksums[assetName] || FALLBACK_CHECKSUMS[assetName];
  const destPath = join(binDir, assetName);

  if (!expectedSha256) {
    throw new Error(`unknown asset checksum for ${assetName}`);
  }

  // Skip when the exact version is already installed and intact (unless FORCE_ENGINE_UPDATE is set).
  try {
    if (!process.env.FORCE_ENGINE_UPDATE && statSync(destPath).size > 0) {
      const existing = createHash('sha256').update(readFileSync(destPath)).digest('hex');
      if (existing === expectedSha256) {
        console.log(JSON.stringify({ event: 'setup_engine_skipped', reason: `${version} ${assetName} already installed`, path: destPath }));
        if (process.platform !== 'win32') {
          try { chmodSync(destPath, 0o755); } catch { /* ignore platform chmod error */ }
        }
        return destPath;
      }
    }
  } catch {
    /* not installed yet */
  }

  console.log(JSON.stringify({ event: 'setup_engine_start', version, asset: assetName }));
  const url = `${baseUrl}/${assetName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} from ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `integrity check failed for ${assetName}: expected ${expectedSha256}, got ${actualSha256}. ` +
        'Refusing to install. The release or your network may be compromised.',
    );
  }

  const tmpPath = `${destPath}.download`;
  writeFileSync(tmpPath, buffer, { mode: 0o755 });
  rmSync(destPath, { force: true });
  renameSync(tmpPath, destPath);
  if (process.platform !== 'win32') {
    try { chmodSync(destPath, 0o755); } catch { /* ignore platform chmod error */ }
  }

  console.log(JSON.stringify({
    event: 'setup_engine_complete',
    version,
    path: destPath,
    sha256: actualSha256,
    bytes: buffer.byteLength,
  }));
  return destPath;
}

export async function ensureLinuxBinary(releaseInfo) {
  mkdirSync(binDir, { recursive: true });
  const info = releaseInfo || (await resolveReleaseInfo());
  const linuxAssetPath = await downloadAsset('yt-dlp_linux', info);
  const genericLinuxPath = join(binDir, 'yt-dlp');
  if (existsSync(linuxAssetPath) && linuxAssetPath !== genericLinuxPath) {
    copyFileSync(linuxAssetPath, genericLinuxPath);
    if (process.platform !== 'win32') {
      try { chmodSync(genericLinuxPath, 0o755); } catch { /* ignore platform chmod error */ }
    }
  }
  return genericLinuxPath;
}

async function main() {
  mkdirSync(binDir, { recursive: true });

  const releaseInfo = await resolveReleaseInfo();
  const isTargetLinux = process.argv.includes('--target-linux');
  const isLinuxOrProd = process.platform === 'linux' || process.env.NODE_ENV === 'production';
  const primaryAsset = ASSET_BY_PLATFORM[process.platform] || 'yt-dlp_linux';

  await downloadAsset(primaryAsset, releaseInfo);

  if (isTargetLinux || isLinuxOrProd || primaryAsset === 'yt-dlp_linux') {
    await ensureLinuxBinary(releaseInfo);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'setup_engine_failed', message: err.message }));
  process.exit(1);
});

