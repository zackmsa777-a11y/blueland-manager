'use strict';

const SIZE = 440;
const COLORS = [0x000000, 0x102341, 0xc7d8ed, 0x174070, 0xffffff, 0x0a182e, 0x82cfff, 0x1c6699,
  0x314c70, 0x569bd1, 0xedf6ff, 0x7390b6, 0x265887, 0x97b8dc, 0xdcf3ff, 0x0e2a50];
const TAU = 2 * Math.PI;
const xy = (radius, a) => `${(220 + radius * Math.cos(a)).toFixed(3)} ${(220 + radius * Math.sin(a)).toFixed(3)}`;
const svg = (width, height, view, body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${view}">${body}</svg>`;
const escape = (text, limit) => {
  const points = Array.from(String(text ?? '').toWellFormed().replace(/[\u0000-\u001f\u007f\ufffe\uffff]/gu, ' '));
  return (points.length > limit ? points.slice(0, limit - 1).join('') + '…' : points.join(''))
    .replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[c]);
};
const text = (value, x, y, size, fill, limit = 30) => `<text x="${x}" y="${y}" font-family="IBM Plex Sans Arabic" font-weight="700" font-size="${size}" fill="${fill}" text-anchor="middle" direction="rtl" unicode-bidi="plaintext">${escape(value, limit)}</text>`;

function wheelBody(names, selected, turn, avatar) {
  const count = Math.max(2, names.length);
  const step = TAU / count;
  const offset = -(Math.max(0, selected) + 0.5) * step + turn;
  const stop = turn === 0 && selected >= 0;
  const rim = '<circle cx="220" cy="220" r="208" fill="#0a182e" stroke="#314c70" stroke-width="5"/><circle cx="220" cy="220" r="202" fill="#c7d8ed" stroke="#edf6ff" stroke-width="4"/>';
  const wedges = Array.from({length: count}, (_, i) => {
    const from = offset + step * i;
    const mid = from + step / 2;
    const selectedWedge = stop && i === selected;
    const fill = selectedWedge ? '#1c6699' : i % 2 ? '#c7d8ed' : '#174070';
    const color = !selectedWedge && i % 2 ? '#102341' : '#ffffff';
    const tilt = mid * 180 / Math.PI + (Math.cos(mid) < 0 ? 180 : 0);
    const [labelX, labelY] = xy(143, mid).split(' ');
    const fontSize = count > 8 ? 16 : 19;
    return `<path d="M220 220 L${xy(199, from)} A199 199 0 0 1 ${xy(199, from + step)} Z" fill="${fill}" stroke="#edf6ff" stroke-width="2.3"/>` +
      `<g transform="translate(${labelX} ${labelY}) rotate(${tilt.toFixed(3)})">${text(names[i], 0, 5, fontSize, color, count > 8 ? 12 : 14)}</g>`;
  }).join('');
  const mark = avatar
    ? `<defs><clipPath id="roulette-avatar"><circle cx="220" cy="220" r="55"/></clipPath></defs><image x="165" y="165" width="110" height="110" xlink:href="${avatar}" clip-path="url(#roulette-avatar)" preserveAspectRatio="xMidYMid slice"/>`
    : text('BL', 220, 234, 43, '#edf6ff', 2);
  return rim + wedges + '<circle cx="220" cy="220" r="59" fill="#0e2a50" stroke="#edf6ff" stroke-width="4"/>' + mark +
    '<path d="M 434 205 L 410 220 L 434 235 Z" fill="#edf6ff" stroke="#569bd1" stroke-width="2" stroke-linejoin="round"/>';
}

function rouletteWheelSvg(names, selected, turn = 0, size = SIZE, avatar) {
  return svg(size, size, `0 0 ${SIZE} ${SIZE}`, wheelBody(names, selected, turn, avatar));
}

function rouletteLobbySvg(banner) {
  const card = `<defs><clipPath id="roulette-banner"><rect x="212" y="39" width="604" height="211" rx="26"/></clipPath></defs>` +
    '<rect x="206" y="33" width="616" height="223" rx="32" fill="#0a182e" stroke="#174070" stroke-width="3"/>' +
    `<image x="212" y="39" width="604" height="211" xlink:href="${banner}" preserveAspectRatio="xMidYMid meet" clip-path="url(#roulette-banner)"/>` +
    '<path d="M62 22 L68 40 L86 46 L68 52 L62 70 L56 52 L38 46 L56 40 Z M35 209 L39 220 L50 224 L39 228 L35 239 L31 228 L20 224 L31 220 Z M786 240 L791 252 L803 257 L791 262 L786 274 L781 262 L769 257 L781 252 Z" fill="#82cfff"/>' +
    `<g transform="translate(10 15) scale(.59)">${wheelBody(['', '', '', '', '', '', '', ''], -1, Math.PI / 8)}</g>`;
  return svg(840, 290, '0 0 840 290', card);
}

module.exports = {COLORS, rouletteWheelSvg, rouletteLobbySvg};
