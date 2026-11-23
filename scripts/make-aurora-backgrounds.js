// Render the Aculyze aurora backgrounds (light + dark) to public/img/*.jpg.
// Usage: node scripts/make-aurora-backgrounds.js
// Colour sits at the top-left and bottom-right; the middle stays calm so text
// laid over it keeps its contrast.
const path = require('path');
const { chromium } = require('playwright');

const W = 2400;
const H = 1500;

function svg(theme) {
  const dark = theme === 'dark';
  const base1 = dark ? '#0B1230' : '#F7F8FD';
  const base2 = dark ? '#101A40' : '#EEF1FA';
  const k = dark ? 1 : 1;
  // [colour, opacity] per ribbon
  const indigo = dark ? ['#6366F1', 0.75] : ['#A5B0FF', 0.75];
  const teal = dark ? ['#2DD4BF', 0.55] : ['#8FE6D6', 0.7];
  const violet = dark ? ['#A78BFA', 0.5] : ['#D3C4FF', 0.7];
  const coral = dark ? ['#FB7185', 0.42] : ['#FFC2B8', 0.75];
  const amber = dark ? ['#FBBF24', 0.18] : ['#FFE2A8', 0.55];
  const grain = dark ? 0.06 : 0.04;
  const stars = dark
    ? Array.from({ length: 70 }, (_, i) => {
      const x = (i * 977) % W;
      const y = (i * 613) % (H * 0.55);
      const r = (i % 7 === 0) ? 1.6 : 0.9;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${0.25 + (i % 5) * 0.08}"/>`;
    }).join('')
    : '';
  // Vertical curtain streaks under the main ribbon (the "aurora" look).
  const curtains = Array.from({ length: 16 }, (_, i) => {
    const x = 120 + i * 62 + (i % 3) * 14;
    const h = 260 + (i * 47) % 220;
    const y = 120 + (i * 31) % 90;
    return `<rect x="${x}" y="${y}" width="${22 + (i % 4) * 8}" height="${h}" fill="url(#curtain)" opacity="${0.35 + (i % 4) * 0.12}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${base1}"/><stop offset="1" stop-color="${base2}"/>
    </linearGradient>
    <linearGradient id="r1" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${teal[0]}"/><stop offset="0.45" stop-color="${indigo[0]}"/><stop offset="1" stop-color="${violet[0]}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="r2" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="${coral[0]}"/><stop offset="0.5" stop-color="${violet[0]}"/><stop offset="1" stop-color="${indigo[0]}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="curtain" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${teal[0]}" stop-opacity="0"/>
      <stop offset="0.35" stop-color="${teal[0]}" stop-opacity="${dark ? 0.55 : 0.6}"/>
      <stop offset="1" stop-color="${indigo[0]}" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" filterUnits="userSpaceOnUse" x="-600" y="-600" width="${W + 1200}" height="${H + 1200}"><feGaussianBlur stdDeviation="70"/></filter>
    <filter id="softer" filterUnits="userSpaceOnUse" x="-600" y="-600" width="${W + 1200}" height="${H + 1200}"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ${grain * 3} 0"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#base)"/>
  ${stars}
  <!-- top-left ribbon -->
  <g filter="url(#soft)" opacity="${indigo[1] * k}">
    <path d="M -200 420 C 300 120, 700 520, 1250 260 S 2000 40, 2500 180" stroke="url(#r1)" stroke-width="260" fill="none" stroke-linecap="round"/>
  </g>
  <g filter="url(#softer)">${curtains}</g>
  <g filter="url(#soft)" opacity="${teal[1]}">
    <ellipse cx="260" cy="180" rx="520" ry="260" fill="${teal[0]}"/>
  </g>
  <!-- bottom-right ribbon -->
  <g filter="url(#soft)" opacity="${coral[1]}">
    <path d="M 2600 1180 C 2100 1460, 1700 1040, 1250 1300 S 700 1500, 300 1420" stroke="url(#r2)" stroke-width="240" fill="none" stroke-linecap="round"/>
  </g>
  <g filter="url(#soft)" opacity="${amber[1]}">
    <ellipse cx="2150" cy="1380" rx="420" ry="200" fill="${amber[0]}"/>
  </g>
  <g filter="url(#soft)" opacity="${violet[1] * 0.7}">
    <ellipse cx="2250" cy="420" rx="380" ry="300" fill="${violet[0]}"/>
  </g>
  <rect width="${W}" height="${H}" filter="url(#grain)"/>
</svg>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (const theme of ['light', 'dark']) {
    await page.setContent(`<html><body style="margin:0">${svg(theme)}</body></html>`);
    await page.waitForTimeout(300);
    const out = path.join(__dirname, '..', 'public', 'img', `aurora-${theme}.jpg`);
    await page.screenshot({ path: out, type: 'jpeg', quality: 80 });
    console.log('wrote', out);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
