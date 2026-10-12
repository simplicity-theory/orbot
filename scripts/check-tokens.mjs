#!/usr/bin/env node
// Design-token guard: component styles must use CSS custom properties, never raw
// colours or lengths. Raw values belong in apps/web/src/styles/_tokens.scss only.
// Media-query breakpoints are exempt (custom properties cannot be used there).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const appDir = join(root, 'apps/web/src/app');
const RAW = [
  { name: 'hex colour', re: /#[0-9a-fA-F]{3,8}\b/ },
  { name: 'rgb()/hsl() colour', re: /\b(?:rgba?|hsla?)\(/ },
  { name: 'raw length', re: /(?<![\w-])\d*\.?\d+(?:px|rem|em|vw|vh)\b/ },
];

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(scss|ts)$/.test(f) && !f.endsWith('.spec.ts')) yield p;
  }
}

/** Style text of a file: whole .scss, or the `styles: \`…\`` block of a component. */
function styleText(path) {
  const src = readFileSync(path, 'utf8');
  if (path.endsWith('.scss')) return src;
  const m = src.match(/styles:\s*`([\s\S]*?)`/);
  return m ? m[1] : '';
}

let problems = 0;
for (const f of files(appDir)) {
  const lines = styleText(f).split('\n');
  lines.forEach((line, i) => {
    if (line.includes('@media') || line.trim().startsWith('//')) return;
    for (const { name, re } of RAW) {
      if (re.test(line)) {
        problems++;
        console.log(`${relative(root, f)}: ${name} in styles: ${line.trim()}`);
      }
    }
  });
}
if (problems) {
  console.log(
    `\n✖ ${problems} raw style value(s). Use a token from apps/web/src/styles/_tokens.scss.`,
  );
  process.exit(1);
}
console.log('✔ Component styles use design tokens only.');
