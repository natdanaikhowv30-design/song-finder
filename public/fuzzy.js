/**
 * fuzzy.js — Approximate String Matching Module
 * อัลกอริทึม: Optimal String Alignment (OSA) + Sørensen–Dice Bigram Coefficient
 * รองรับ: Thai diacritic folding, Kedmanee keyboard layout correction
 */

/* ---------- Normalization Layer ---------- */
// สระบน/ล่าง + วรรณยุกต์ + ทัณฑฆาต — แหล่งพิมพ์ผิดหลักในภาษาไทย
const THAI_MARKS = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;
const LATIN_MARKS = /[\u0300-\u036F]/g;

export const norm = (v) =>
  String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** fold: ลด noise ให้เหลือเฉพาะโครงพยัญชนะ — ทนต่อวรรณยุกต์/สระผิด */
export const fold = (v) =>
  norm(v)
    .normalize('NFD').replace(LATIN_MARKS, '')
    .normalize('NFC').replace(THAI_MARKS, '')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/* ---------- Edit Distance (bounded OSA) ---------- */
export function osa(a, b, max = Infinity) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  if (Math.abs(la - lb) > max) return max + 1;

  let prev2 = [], prev = new Array(lb + 1), cur;
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // transposition: สลับตัวอักษร เช่น "ตัว" -> "ตวั"
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;   // early termination
    prev2 = prev; prev = cur;
  }
  return prev[lb];
}

/* ---------- Sørensen–Dice Bigram Coefficient ---------- */
export function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bag = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bag.set(g, (bag.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = bag.get(g) || 0;
    if (c > 0) { bag.set(g, c - 1); hits++; }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

/* ---------- Composite Similarity ---------- */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  // budget ปรับตามความยาว: คำสั้นยอมพลาดน้อย คำยาวยอมพลาดมาก
  const budget = maxLen <= 4 ? 1 : maxLen <= 8 ? 2 : maxLen <= 14 ? 3 : 4;
  const d = osa(a, b, budget);
  const editSim = d > budget ? 0 : 1 - d / maxLen;
  return Math.max(editSim, dice(a, b));   // ใช้ค่าที่ผ่อนปรนกว่า
}

/* ---------- Sliding-window partial match ---------- */
export function containsFuzzy(hay, needle) {
  if (!needle || !hay) return 0;
  if (hay.includes(needle)) return 1;
  const n = needle.length;
  if (n < 2) return 0;
  if (hay.length <= n) return similarity(hay, needle);

  const win = Math.min(hay.length, n + 2);
  let best = 0;
  for (let i = 0; i + n - 2 <= hay.length; i++) {
    const s = similarity(hay.slice(i, i + win), needle);
    if (s > best) best = s;
    if (best >= 0.999) break;
  }
  return best;
}

/* ---------- Kedmanee Layout Correction ---------- */
// แก้กรณีพิมพ์ไทยขณะคีย์บอร์ดเป็นอังกฤษ เช่น "vbfow" -> "อิดถไ"
const EN2TH = {
  q:'ๆ', w:'ไ', e:'ำ', r:'พ', t:'ะ', y:'ั', u:'ี', i:'ร', o:'น', p:'ย', '[':'บ', ']':'ล',
  a:'ฟ', s:'ห', d:'ก', f:'ด', g:'เ', h:'้', j:'่', k:'า', l:'ส', ';':'ว', "'":'ง',
  z:'ผ', x:'ป', c:'แ', v:'อ', b:'ิ', n:'ื', m:'ท', ',':'ม', '.':'ใ', '/':'ฝ',
};
const TH2EN = Object.fromEntries(Object.entries(EN2TH).map(([k, v]) => [v, k]));

export function swapLayout(input) {
  const str = String(input || '').toLowerCase();
  if (!str) return '';
  const isThai = /[\u0E00-\u0E7F]/.test(str);
  const map = isThai ? TH2EN : EN2TH;
  let out = '', hits = 0;
  for (const ch of str) {
    if (map[ch]) { out += map[ch]; hits++; } else out += ch;
  }
  // ต้องแปลงได้เกินครึ่ง จึงถือว่าเป็นการสลับ layout จริง
  return hits >= Math.ceil(str.replace(/\s/g, '').length * 0.5) ? out : '';
}
