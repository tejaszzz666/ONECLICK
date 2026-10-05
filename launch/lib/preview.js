'use strict';

// Pre-flight check for the "Open the page now" option (raw.githack.com).
// Pure function over the HTML text of the page. It only reports things the file itself says.
// It cannot know whether the page will really render; it finds the common, concrete reasons it would not.

const TAG = /<(script|link|img|source|video|audio)\b[^>]*>/gi;
const ATTR = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
const SRC = ATTR('src');
const HREF = ATTR('href');
const REL = ATTR('rel');
const SOURCE_EXT = /\.(jsx|tsx|ts|vue|svelte)(\?|#|$)/i;

function checkPreviewHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const absolute = [];
  const insecure = [];
  const source = [];
  for (const m of html.matchAll(TAG)) {
    const tag = m[1].toLowerCase();
    const text = m[0];
    let url = null;
    if (tag === 'link') {
      const rel = (REL.exec(text) || [])[1] || '';
      // icons, canonical links and the like are not needed to render the page
      if (!/stylesheet|modulepreload|preload/i.test(rel)) continue;
      url = (HREF.exec(text) || [])[1];
    } else {
      url = (SRC.exec(text) || [])[1];
    }
    if (!url) continue;
    url = url.trim();
    if (tag === 'script' && SOURCE_EXT.test(url)) source.push(url);
    if (/^\/(?!\/)/.test(url)) absolute.push(url);
    else if (/^http:\/\//i.test(url)) insecure.push(url);
  }
  const eg = (list) => [...new Set(list)].slice(0, 2).join(', ');
  const issues = [];
  if (source.length) {
    issues.push({
      severity: 'blocks',
      code: 'needs-build',
      message: `This page loads source files that browsers cannot run directly (${eg(source)}). It needs a build step first, so opening the page as-is will most likely show a blank page.`,
    });
  }
  if (absolute.length) {
    issues.push({
      severity: 'limits',
      code: 'absolute-paths',
      message: `This page loads files by absolute path (${eg(absolute)}). On a plain file host those paths point at the wrong place, so styles or scripts may be missing. A deployed copy serves them from the site root.`,
    });
  }
  if (insecure.length) {
    issues.push({
      severity: 'limits',
      code: 'insecure-assets',
      message: `This page loads resources over plain http (${eg(insecure)}). Browsers block those on an https page, so some parts may not appear.`,
    });
  }
  return issues;
}

module.exports = { checkPreviewHtml };
