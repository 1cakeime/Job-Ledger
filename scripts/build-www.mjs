// Copies the web app into www/ for Capacitor. The site itself stays at the repo root for GitHub Pages.
import { rmSync, mkdirSync, cpSync } from 'node:fs';
const out = 'www';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'portal-owner.js', 'portal.html', 'manifest.webmanifest', 'sw.js', 'icons', 'vendor']) cpSync(f, `${out}/${f}`, { recursive: true });
console.log('Built www/');
