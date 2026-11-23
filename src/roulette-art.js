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
    const fill = selectedWedge ? '#569bd1' : ['#102341', '#174070', '#1c6699', '#265887'][i % 4];
    const tilt = mid * 180 / Math.PI + (Math.cos(mid) < 0 ? 180 : 0);
    const [labelX, labelY] = xy(143, mid).split(' ');
    const label = count <= 18 ? `<g transform="translate(${labelX} ${labelY}) rotate(${tilt.toFixed(3)})">${text(names[i], 0, 5, count > 8 ? 14 : 18, '#ffffff', count > 8 ? 11 : 14)}</g>` : '';
    return `<path d="M220 220 L${xy(199, from)} A199 199 0 0 1 ${xy(199, from + step)} Z" fill="${fill}" stroke="#c7d8ed" stroke-opacity=".65" stroke-width="${count > 40 ? .55 : 1.5}"/>${label}`;
  }).join('');
  const mark = avatar
    ? `<defs><clipPath id="roulette-avatar"><circle cx="220" cy="220" r="55"/></clipPath></defs><image x="165" y="165" width="110" height="110" xlink:href="${avatar}" clip-path="url(#roulette-avatar)" preserveAspectRatio="xMidYMid slice"/>`
    : text('BL', 220, 234, 43, '#edf6ff', 2);
  return rim + wedges + '<circle cx="220" cy="220" r="59" fill="#0e2a50" stroke="#edf6ff" stroke-width="4"/>' + mark +
    '<path d="M 434 205 L 410 220 L 434 235 Z" fill="#edf6ff" stroke="#569bd1" stroke-width="2" stroke-linejoin="round"/>';
}

const stars = Array.from({length: 100}, (_, i) => {
  const x = 6 + (i * 137 % 428), y = 6 + (i * 89 % 428);
  return i % 12 === 0
    ? `<path d="M${x - 4} ${y}h8m-4 -4v8" stroke="#cbeaff" stroke-opacity=".76"/>`
    : `<circle cx="${x}" cy="${y}" r="${i % 3 === 0 ? 1.3 : .6}" fill="#a4d7ff" opacity=".68"/>`;
}).join('');

function rouletteWheelSvg(names, selected, turn = 0, size = SIZE, avatar, backdrop) {
  const sky = '<defs><radialGradient id="sky"><stop stop-color="#174070"/><stop offset="1" stop-color="#06132a"/></radialGradient><clipPath id="wheel-frame"><rect width="440" height="440" rx="18"/></clipPath></defs>' +
    '<rect width="440" height="440" rx="18" fill="url(#sky)"/>' + (backdrop
    ? `<image width="440" height="440" xlink:href="${backdrop}" preserveAspectRatio="xMidYMid slice" clip-path="url(#wheel-frame)"/>` : '');
  const label = turn === 0 && selected >= 0 && names.length > 18
    ? `<rect x="80" y="368" width="280" height="42" rx="12" fill="#06152d" stroke="#82cfff"/>${text(names[selected], 220, 395, 20, '#ffffff', 23)}` : '';
  return svg(size, size, `0 0 ${SIZE} ${SIZE}`, sky + wheelBody(names, selected, turn, avatar) + stars + label);
}

function rouletteLobbySvg(banner) {
  const card = `<defs><clipPath id="roulette-banner"><rect x="212" y="39" width="604" height="211" rx="26"/></clipPath></defs>` +
    '<rect x="206" y="33" width="616" height="223" rx="32" fill="#0a182e" stroke="#174070" stroke-width="3"/>' +
    `<image x="212" y="39" width="604" height="211" xlink:href="${banner}" preserveAspectRatio="xMidYMid meet" clip-path="url(#roulette-banner)"/>` +
    '<path d="M62 22 L68 40 L86 46 L68 52 L62 70 L56 52 L38 46 L56 40 Z M35 209 L39 220 L50 224 L39 228 L35 239 L31 228 L20 224 L31 220 Z M786 240 L791 252 L803 257 L791 262 L786 274 L781 262 L769 257 L781 252 Z" fill="#82cfff"/>' +
    `<g transform="translate(10 15) scale(.59)">${wheelBody(['', '', '', '', '', '', '', ''], -1, Math.PI / 8)}</g>`;
  return svg(840, 290, '0 0 840 290', card);
}

function rouletteWinnerSvg({name, avatar, reward, style}) {
  const {color, dark} = style;
  const portrait = avatar
    ? `<image x="310" y="107" width="200" height="200" xlink:href="${avatar}" clip-path="url(#portrait)" preserveAspectRatio="xMidYMid slice"/>`
    : text('BL', 410, 226, 62, '#edf6ff', 2);
  const stars = Array.from({length: 66}, (_, i) => {
    const x = 18 + (i * 137 % 782);
    const y = 15 + (i * 83 % 470);
    return `<circle cx="${x}" cy="${y}" r="${i % 7 === 0 ? 2.5 : 1}" fill="${color}" opacity="${i % 7 === 0 ? '.65' : '.34'}"/>`;
  }).join('');
  const body = `<defs><radialGradient id="winner-bg"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="#060e22"/></radialGradient>` +
    '<clipPath id="portrait"><circle cx="410" cy="207" r="100"/></clipPath></defs>' +
    `<rect x="6" y="6" width="808" height="488" rx="34" fill="url(#winner-bg)" stroke="${color}" stroke-width="2"/>` + stars +
    `<circle cx="410" cy="207" r="125" fill="none" stroke="${color}" stroke-opacity=".44" stroke-width="2" stroke-dasharray="2 8"/>` +
    `<circle cx="410" cy="207" r="105" fill="#102341" stroke="${color}" stroke-width="5"/>` + portrait +
    '<path d="M365 91 L355 47 L386 66 L410 31 L433 66 L465 47 L455 91 Z M367 97 H453 V105 H367 Z" fill="#ffd975" stroke="#fff3c5" stroke-width="2.5" stroke-linejoin="round"/>' +
    text('بطل الروليت', 410, 361, 30, color) + text(name, 410, 416, 44, '#edf6ff', 25) +
    text(reward ? `+${reward} نقاط` : 'BLUE LAND', 410, 462, 23, color);
  return svg(820, 500, '0 0 820 500', body);
}

module.exports = {COLORS, rouletteWheelSvg, rouletteLobbySvg, rouletteWinnerSvg};
