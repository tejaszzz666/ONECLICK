'use strict';

// Vercel build step: copies the site (kept as one HTML file with a long name)
// to public/index.html. The source file stays the single source of truth.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readdirSync(root).find((f) => f.startsWith('OneClick') && f.endsWith('.html'));
if (!src) {
  console.error('Site HTML not found in repo root.');
  process.exit(1);
}
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.copyFileSync(path.join(root, src), path.join(root, 'public', 'index.html'));
console.log(`Built public/index.html from "${src}"`);
// extra pages (served without the .html extension thanks to cleanUrls)
for (const page of ['launch.html']) {
  const from = path.join(root, page);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(root, 'public', page));
    console.log(`Built public/${page}`);
  } else {
    console.error(`Missing page: ${page}`);
    process.exit(1);
  }
}
