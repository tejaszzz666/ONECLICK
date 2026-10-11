'use strict';

// Repository health summary. Pure function over data the analyzer already has (GitHub repo metadata
// and the file tree). It reports facts, not a score. Missing data is left out, never guessed.

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|UNLICENSE)(\.[A-Za-z]+)?$/i;

function ago(days) {
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function buildHealth(meta, paths, now = new Date()) {
  const items = [];
  let lastPush = null;

  if (meta && meta.pushedAt) {
    const t = Date.parse(meta.pushedAt);
    if (!Number.isNaN(t)) {
      const ageDays = Math.max(0, Math.floor((now.getTime() - t) / 86400000));
      lastPush = { at: new Date(t).toISOString(), ageDays };
      const stale = ageDays >= 730;
      items.push({
        level: stale ? 'warn' : ageDays >= 365 ? 'info' : 'ok',
        text: `Last pushed ${ago(ageDays)}.${stale ? ' Dependencies and tools may need updating before it runs.' : ''}`,
      });
    }
  }

  const licenseName = meta && meta.license ? String(meta.license) : null;
  const fileFound = [...paths].some((p) => !p.includes('/') && LICENSE_FILE.test(p));
  if (licenseName) items.push({ level: 'ok', text: `License: ${licenseName}.` });
  else if (fileFound) items.push({ level: 'info', text: 'A license file is present, but GitHub could not identify which license it is. Read it before reusing the code.' });
  else items.push({ level: 'warn', text: 'No license found. Without one, others have no explicit permission to reuse or redistribute the code.' });

  if (meta && meta.fork) items.push({ level: 'info', text: 'This repository is a fork of another project.' });

  return { lastPush, license: { name: licenseName, fileFound }, items };
}

module.exports = { buildHealth };
