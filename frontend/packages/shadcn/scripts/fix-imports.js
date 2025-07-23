/* eslint-disable @typescript-eslint/no-require-imports */

// scripts/fix-imports.js
const fs = require('fs');
const path = require('path');

// Find project root (one level up from scripts)
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const ALIAS = '@/';

function walk(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);

    if (stat.isDirectory()) {
      walk(filepath, fileList);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      fileList.push(filepath);
    }
  });

  return fileList;
}

function aliasToRelative(fromFile, importPath) {
  if (!importPath.startsWith(ALIAS)) {
    return importPath;
  }

  const fromDir = path.dirname(fromFile);
  const target = path.join(SRC_DIR, importPath.slice(ALIAS.length));
  let rel = path.relative(fromDir, target);

  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }

  return rel.replace(/\\/g, '/');
}

function processFile(filePath) {
  let changed = false;
  let content = fs.readFileSync(filePath, 'utf8');

  content = content.replace(
    /(import\s.+?from\s+['"])(@\/[^'"]+)(['"]\s*;?)/g,
    (match, before, importPath, after) => {
      const rel = aliasToRelative(filePath, importPath);
      changed = true;

      return `${before}${rel}${after}`;
    },
  );

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Rewrote:', path.relative(PROJECT_ROOT, filePath));
  }
}

if (!fs.existsSync(SRC_DIR)) {
  console.error(`Cannot find src directory at ${SRC_DIR}`);
  process.exit(1);
}

const allFiles = walk(SRC_DIR);
allFiles.forEach(processFile);

console.log('\nDone! All "@/..." imports in src/ are now relative.');
