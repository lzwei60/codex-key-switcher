import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const bundleRoot = process.argv[2];
if (!bundleRoot) {
  throw new Error('Usage: node scripts/verify-tauri-bundle.mjs <bundle-directory>');
}

const expectedIdentifier = 'com.codexkeyswitcher.tauri.preview';
function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

const allFiles = walk(bundleRoot);
const accepted = os.platform() === 'darwin'
  ? allFiles.filter((file) => file.endsWith('.app/Contents/Info.plist'))
  : os.platform() === 'win32'
    ? allFiles.filter((file) => /\.(msi|exe)$/i.test(file))
    : allFiles.filter((file) => /\.(AppImage|deb)$/i.test(file));

if (!accepted.length) {
  throw new Error(`No Tauri bundle found in ${bundleRoot}`);
}

for (const file of accepted) {
  const stat = fs.statSync(file);
  if (stat.size < 1024) throw new Error(`Bundle is unexpectedly small: ${file}`);
}

if (os.platform() === 'darwin') {
  for (const plist of accepted) {
    const text = fs.readFileSync(plist, 'utf8');
    if (!text.includes(expectedIdentifier)) {
      throw new Error(`Unexpected bundle identifier in ${plist}`);
    }
    const executable = path.join(path.dirname(plist), 'MacOS', 'codex-key-switcher-tauri');
    const fileDescription = execFileSync('file', [executable], { encoding: 'utf8' });
    if (!fileDescription.includes('arm64')) {
      throw new Error(`Expected arm64 macOS executable: ${fileDescription.trim()}`);
    }
  }
} else if (os.platform() === 'linux') {
  const appImages = accepted.filter((file) => file.endsWith('.AppImage'));
  const debs = accepted.filter((file) => file.endsWith('.deb'));
  if (!appImages.length || !debs.length) throw new Error('Expected both AppImage and deb bundles');
  for (const file of appImages) {
    const bytes = fs.readFileSync(file);
    if (bytes[0] !== 0x7f || bytes.toString('ascii', 1, 4) !== 'ELF' || bytes[4] !== 2) {
      throw new Error(`Expected x86_64 ELF AppImage: ${file}`);
    }
    if (bytes.readUInt16LE(18) !== 0x3e) throw new Error(`Expected x86_64 AppImage: ${file}`);
  }
  for (const file of debs) {
    const header = fs.readFileSync(file).subarray(0, 8).toString('ascii');
    if (header !== '!<arch>\n') throw new Error(`Invalid Debian archive: ${file}`);
  }
} else if (os.platform() === 'win32') {
  for (const file of accepted) {
    const header = fs.readFileSync(file).subarray(0, 2).toString('ascii');
    if (header !== 'MZ') throw new Error(`Expected Windows PE/NSIS bundle: ${file}`);
  }
}

console.log(JSON.stringify({ platform: os.platform(), bundles: accepted.map((file) => path.relative(bundleRoot, file)), expectedIdentifier }));
