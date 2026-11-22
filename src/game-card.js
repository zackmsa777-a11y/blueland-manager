'use strict';

const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {Resvg} = require('@resvg/resvg-js');
const assets = join(__dirname, 'game-assets');
const banners = Object.fromEntries(['roulette', 'mafia', 'chairs'].map(game =>
  [game, readFileSync(join(assets, game + '.jpg')).toString('base64')]));
const font = {loadSystemFonts: false, fontFiles: [join(assets, 'IBMPlexSansArabic-Bold.ttf')],
  defaultFontFamily: 'IBM Plex Sans Arabic'};

const palette = {
  roulette: { accent: '#9fd5ff', dark: '#102c51', colors: ['#18518c', '#303f7a', '#247289', '#445a90'] },
  chairs: { accent: '#80e1ff', dark: '#0b243e', colors: ['#23567c', '#224564'] },
  mafia: { accent: '#f99cb4', dark: '#2b152b', colors: ['#6d3657', '#543451'] },
  rps: { accent: '#a8e7ab', dark: '#132d34' }
};

function escapeXml(value, limit) {
  const safe = String(value ?? '').toWellFormed().replace(/[\u0000-\u001f\u007f\ufffe\uffff]/gu, ' ');
  const chars = Array.from(safe);
  return (chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : safe)
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function caption(value, x, y, size, { color = '#f7f4ff', limit = 46 } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="middle" direction="rtl" unicode-bidi="plaintext">${escapeXml(value, limit)}</text>`;
}

function point(x, y, radius, angle) {
  return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)].map(n => n.toFixed(2)).join(' ');
}

function wheel(items, selected, theme) {
  const count = Math.max(2, items.length);
  const step = 2 * Math.PI / count;
  const rotation = -Math.PI / 2 - (Math.max(0, selected) + 0.5) * step;
  const x = items.length ? 228 : 410;
  const y = 264;
  const rim = `<circle cx="${x}" cy="${y}" r="127" fill="#0a1327" stroke="${theme.accent}" stroke-width="3"/>`;
  const wedges = Array.from({ length: count }, (_, index) => {
    const start = rotation + index * step;
    const end = start + step;
    const fill = index === selected ? '#397da8' : theme.colors[index % theme.colors.length];
    const [labelX, labelY] = point(x, y, 84, start + step / 2).split(' ');
    return `<path d="M ${x} ${y} L ${point(x, y, 119, start)} A 119 119 0 0 1 ${point(x, y, 119, end)} Z" fill="${fill}" stroke="#15152b" stroke-width="2"/>` +
      caption(index + 1, labelX, Number(labelY) + 5, 17, { limit: 2 });
  }).join('');
  const hub = `<circle cx="${x}" cy="${y}" r="24" fill="#11182c" stroke="${theme.accent}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="7" fill="${theme.accent}"/><path d="M ${x - 13} 131 H ${x + 13} L ${x} 158 Z" fill="${theme.accent}"/>`;
  const roster = items.map((item, index) => {
    const column = items.length > 8 ? Math.floor(index / 8) : 0;
    const left = items.length > 8 ? 380 + column * 196 : 404;
    const width = items.length > 8 ? 184 : 336;
    const row = index % 8;
    const top = 145 + row * 30;
    const active = index === selected;
    const badge = active ? theme.accent : '#959eba';
    return `<rect x="${left}" y="${top}" width="${width}" height="25" rx="8" fill="${active ? '#245071' : '#101b33'}"/>` +
      caption(index + 1, left + 18, top + 17, 12, { color: badge, limit: 2 }) +
      caption(item.label, left + width / 2 + 9, top + 17, 15, { limit: items.length > 8 ? 14 : 26 });
  }).join('');
  return rim + wedges + hub + roster;
}

function chairBoard(items, selected, theme) {
  const seats = items.length ? items : Array.from({ length: 5 }, () => ({ label: '' }));
  const columns = Math.min(6, seats.length);
  const rows = Math.ceil(seats.length / columns);
  const cell = 112;
  return seats.map((item, index) => {
    const row = Math.floor(index / columns);
    const rowSize = Math.min(columns, seats.length - row * columns);
    const x = 410 - (rowSize - 1) * cell / 2 + (index % columns) * cell;
    const y = 264 - (rows - 1) * 85 / 2 + row * 85;
    const occupied = item.status === 'occupied' || index === selected;
    const shade = occupied ? '#296d88' : theme.colors[index % theme.colors.length];
    const line = occupied ? theme.accent : '#6592b2';
    return `<g transform="translate(${x} ${y})"><rect x="-43" y="-33" width="86" height="67" rx="15" fill="#0d1b31"/>` +
      `<path d="M -20 -8 V -25 Q -20 -29 -15 -29 H 15 Q 20 -29 20 -25 V -8 M -25 -8 H 25 V 2 H -25 Z M -20 2 V 12 M 20 2 V 12" fill="${shade}" stroke="${line}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` +
      caption(item.label || index + 1, 0, 27, 13, { color: line, limit: 11 }) + '</g>';
  }).join('');
}

function roleIcon(role, accent) {
  const symbols = {
    mafia: '<path d="M -48 -16 Q -27 -27 0 -14 Q 27 -27 48 -16 L 41 15 Q 30 38 10 24 L 0 14 L -10 24 Q -30 38 -41 15 Z"/><path d="M -33 -1 Q -20 -8 -10 2 M 10 2 Q 20 -8 33 -1" stroke="#ffdde6"/>',
    doctor: '<path d="M -13 -44 H 13 V -13 H 44 V 13 H 13 V 44 H -13 V 13 H -44 V -13 H -13 Z"/>',
    detective: '<circle cx="-10" cy="-10" r="30"/><path d="M 12 13 L 42 43" stroke-width="12"/>',
    citizen: '<circle cx="0" cy="-19" r="22"/><path d="M -42 41 Q -40 6 0 6 Q 40 6 42 41 Z"/>'
  };
  return `<g fill="#4f2846" stroke="${accent}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">${symbols[role] || symbols.mafia}</g>`;
}

function mafiaBoard(items, role, theme) {
  if (role || !items.length) {
    return `<circle cx="410" cy="266" r="113" fill="#291c38" stroke="#713851" stroke-width="2"/><circle cx="410" cy="266" r="93" fill="#12182e" stroke="${theme.accent}" stroke-width="2" stroke-dasharray="3 9"/><g transform="translate(410 266)">${roleIcon(role, theme.accent)}</g>`;
  }
  const columns = Math.min(6, items.length);
  const rows = Math.ceil(items.length / columns);
  return items.map((item, index) => {
    const row = Math.floor(index / columns);
    const rowSize = Math.min(columns, items.length - row * columns);
    const x = 410 - (rowSize - 1) * 115 / 2 + (index % columns) * 115;
    const y = 262 - (rows - 1) * 79 / 2 + row * 79;
    const color = item.status === 'out' ? '#adb1c5' : theme.accent;
    return `<g transform="translate(${x} ${y})"><rect x="-51" y="-34" width="102" height="68" rx="14" fill="${item.status === 'out' ? '#172036' : '#361f3e'}"/><g transform="translate(0 -9) scale(.37)">${roleIcon('citizen', color)}</g>` +
      caption(item.label, 0, 24, 14, { color, limit: 12 }) + '</g>';
  }).join('');
}

const duelSymbols = {
  rock: '<path d="M -44 19 L -40 -13 L -17 -34 L 22 -31 L 44 -7 L 37 20 L 11 34 L -19 32 Z"/><path d="M -40 -13 L -12 -9 L 22 -31 M -12 -9 L 11 34" fill="none"/>',
  paper: '<path d="M -30 -42 H 11 L 30 -23 V 42 H -30 Z M 11 -42 V -23 H 30"/><path d="M -17 -9 H 15 M -17 5 H 15 M -17 19 H 8" fill="none"/>',
  scissors: '<path d="M -13 12 L 32 -40 M 13 12 L -32 -40" fill="none" stroke-width="8"/><circle cx="-22" cy="22" r="13"/><circle cx="22" cy="22" r="13"/>'
};

function duelBoard(items, theme) {
  const cards = items.length ? items : [{move: 'rock'}, {move: 'paper'}, {move: 'scissors'}];
  return cards.map((item, index) => {
    const x = 410 + (index - (cards.length - 1) / 2) * 198;
    return `<g transform="translate(${x} 251)"><rect x="-82" y="-91" width="164" height="193" rx="24" fill="#112c3a" stroke="${theme.accent}" stroke-opacity=".5"/>` +
      `<g fill="#235b53" stroke="${theme.accent}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">${duelSymbols[item.move] || '<circle r="32" fill="none" stroke-dasharray="4 9"/>'}</g>` +
      caption(item.label, 0, 71, 15, {limit: 15}) + caption(item.score, 0, 89, 13, {color: theme.accent, limit: 2}) + '</g>';
  }).join('');
}

const boards = {roulette: wheel, chairs: chairBoard, mafia: mafiaBoard, rps: (items, _selected, theme) => duelBoard(items, theme)};

function renderGameCard({ game, title, subtitle = '', footer = '', items = [], selected = -1, role }) {
  const theme = palette[game];
  const visible = items.slice(0, 16);
  const illustration = boards[game](visible, game === 'mafia' ? role : selected, theme);
  const banner = banners[game];
  const offset = banner ? 220 : 0;
  const height = 500 + offset;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="820" height="${height}" viewBox="0 0 820 ${height}" role="img" aria-labelledby="card-title card-description">` +
    `<title id="card-title">${escapeXml(title, 80)}</title><desc id="card-description">${escapeXml([subtitle, footer].filter(Boolean).join(' · '), 150)}</desc>` +
    `<defs><linearGradient id="background" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="${theme.dark}"/><stop offset="1" stop-color="#0b1326"/></linearGradient><pattern id="stars" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${theme.accent}" opacity=".13"/></pattern></defs>` +
    `<rect width="820" height="${height}" fill="url(#background)"/><rect width="820" height="${height}" fill="url(#stars)"/>` +
    (banner ? `<image width="820" height="286" xlink:href="data:image/jpeg;base64,${banner}"/>` : '') +
    `<g transform="translate(0 ${offset})" font-family="IBM Plex Sans Arabic" font-weight="700">` +
    (banner && !role ? '' : caption(title, 410, banner ? 113 : 66, 35, { color: theme.accent, limit: 34 })) +
    caption(subtitle, 410, 105, 19, { limit: 56 }) + illustration +
    `<path d="M 62 422 H 758" stroke="${theme.accent}" stroke-opacity=".35"/>` +
    caption(footer, 410, 455, 18, { limit: 62 }) + '</g></svg>';
  return new Resvg(svg, {font}).render().asPng();
}

const spinColors = [0x09152e, 0x0d2142, 0x173c70, 0x9fd5ff, 0x18518c, 0x303f7a, 0x247289, 0x445a90,
  0xf7f4ff, 0x101b33, 0x397da8, 0x5fa5f4, 0x243661, 0x112748, 0xe5b460, 0x0a1327];
const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];

function gifImage(pixels, side, delay) {
  const descriptor = Buffer.from([0x21, 0xf9, 4, 4, delay, 0, 0, 0, 0x2c, 0, 0, 0, 0, side & 255, side >> 8, side & 255, side >> 8, 0, 4]);
  // Reset before the dictionary can grow past 5-bit codes. Each pixel is a palette index.
  const packed = Buffer.alloc(Math.ceil((pixels.length + Math.ceil(pixels.length / 14) + 1) * 5 / 8));
  let bits = 0;
  let value = 0;
  let offset = 0;
  const code = n => {
    value |= n << bits;
    bits += 5;
    if (bits >= 8) {
      packed[offset++] = value & 255;
      value >>= 8;
      bits -= 8;
    }
  };
  for (let i = 0; i < pixels.length; i++) {
    if (i % 14 === 0) code(16);
    code(pixels[i]);
  }
  code(17);
  if (bits) packed[offset++] = value;
  const blocks = [descriptor];
  for (let i = 0; i < offset; i += 255) {
    const data = packed.subarray(i, Math.min(i + 255, offset));
    blocks.push(Buffer.from([data.length]), data);
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

function renderRouletteSpin(playerCount, selected) {
  const side = 224;
  const center = side / 2;
  const count = Math.max(2, Math.min(16, playerCount));
  const tau = 2 * Math.PI;
  const step = tau / count;
  const finalAngle = -Math.PI / 2 - (selected + 0.5) * step;
  const header = Buffer.alloc(13);
  header.write('GIF89a');
  header.writeUInt16LE(side, 6);
  header.writeUInt16LE(side, 8);
  header[10] = 0xf3;
  const paletteBytes = Buffer.from(spinColors.flatMap(color => [color >> 16, (color >> 8) & 255, color & 255]));
  const frames = [header, paletteBytes];
  for (let frame = 0; frame < 18; frame++) {
    const last = frame === 17;
    const angle = finalAngle - 2 * tau * (1 - frame / 17) ** 2;
    const pixels = Buffer.alloc(side * side);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const dx = x - center;
        const dy = y - center;
        const radius = dx * dx + dy * dy;
        let color = (x * 53 + y * 71 + x * y) % 301 === 1 ? 11 : 0;
        if (radius <= 103 ** 2 && radius > 98 ** 2) color = 3;
        else if (radius <= 98 ** 2) {
          const sector = ((Math.atan2(dy, dx) - angle + 4 * tau) % tau) / step;
          const index = Math.floor(sector);
          color = sector % 1 < 0.025 ? 9 : last && index === selected ? 10 : 4 + index % 4;
          if (radius < 20 ** 2) color = radius > 17 ** 2 || radius < 5 ** 2 ? 3 : 15;
        }
        if (y >= 6 && y <= 28 && Math.abs(dx) <= (28 - y) / 2) color = 14;
        pixels[y * side + x] = color;
      }
    }
    for (let i = 0; i < count; i++) {
      const a = angle + (i + 0.5) * step;
      const label = String(i + 1);
      const x = Math.round(center + 71 * Math.cos(a) - label.length * 4);
      const y = Math.round(center + 71 * Math.sin(a) - 5);
      for (let digit = 0; digit < label.length; digit++) {
        for (let p = 0; p < 15; p++) {
          if (digits[label[digit]][p] !== '1') continue;
          const at = (y + 2 * Math.floor(p / 3)) * side + x + digit * 8 + 2 * (p % 3);
          pixels[at] = pixels[at + 1] = pixels[at + side] = pixels[at + side + 1] = 8;
        }
      }
    }
    frames.push(gifImage(pixels, side, last ? 40 : 8));
  }
  return Buffer.concat([...frames, Buffer.from([0x3b])]);
}

module.exports = { renderGameCard, renderRouletteSpin };
