// expiryParser.js
// Takes raw OCR text from a medicine strip/box and returns the likely expiry date.
// Works in Node, React Native, or any JS backend.

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

// OCR often confuses these characters inside dates.
function cleanOcr(text) {
  return text
    .toUpperCase()
    .replace(/[|]/g, "1")
    .replace(/(?<=\d)O|O(?=\d)/g, "0")
    .replace(/(?<=\d)[IL]|[IL](?=\d)/g, "1")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ");
}

function normYear(y) {
  const n = parseInt(y, 10);
  return y.length === 2 ? 2000 + n : n;
}

// Expiry is valid through the END of the stated month.
function endOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  return d.toISOString().slice(0, 10);
}

function parseExpiry(rawText) {
  const text = cleanOcr(rawText);
  const candidates = [];

  // Prefer text near an EXP keyword; fall back to whole text.
  const expZones = [];
  const kw = /(EXP(?:IRY)?(?:\.|:)?(?: DATE)?|USE BEFORE|BEST BEFORE)\s*[:\-]?\s*([^\n]{0,20})/g;
  let m;
  while ((m = kw.exec(text)) !== null) expZones.push(m[2]);
  const zones = expZones.length ? expZones : [text];

  for (const zone of zones) {
    // 1) MM/YY, MM/YYYY, MM-YY, MM.YYYY
    for (const x of zone.matchAll(/\b(0?[1-9]|1[0-2])\s*[\/\-.]\s*(\d{4}|\d{2})\b/g)) {
      candidates.push({ month: +x[1], year: normYear(x[2]), src: x[0], conf: 0.9 });
    }
    // 2) MMM YY / MMM-YYYY / MMM.YYYY  (AUG 2027, AUG-27)
    for (const x of zone.matchAll(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC)[A-Z]*\.?\s*[\/\-.]?\s*(\d{4}|\d{2})\b/g)) {
      candidates.push({ month: MONTHS[x[1]], year: normYear(x[2]), src: x[0], conf: 0.9 });
    }
    // 3) DD/MM/YYYY (full date)
    for (const x of zone.matchAll(/\b(\d{1,2})[\/\-.](0?[1-9]|1[0-2])[\/\-.](\d{4})\b/g)) {
      candidates.push({ month: +x[2], year: +x[3], src: x[0], conf: 0.8 });
    }
  }

  // Drop impossible years (OCR noise)
  const nowYear = new Date().getFullYear();
  const valid = candidates.filter((c) => c.year >= nowYear - 5 && c.year <= nowYear + 10);
  if (!valid.length) return { found: false, needsConfirm: true };

  // If MFG and EXP both appear, the latest date is the expiry.
  valid.sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));
  const best = valid[0];
  const expiryDate = endOfMonth(best.year, best.month);

  return {
    found: true,
    expiryDate,
    matchedText: best.src,
    // Always show a confirm/edit screen; flag low-confidence reads.
    needsConfirm: !expZones.length || best.conf < 0.9,
  };
}

function expiryStatus(expiryDate, today = new Date()) {
  const days = Math.floor((new Date(expiryDate) - today) / 86400000);
  if (days < 0) return { status: "EXPIRED", days };
  if (days <= 30) return { status: "EXPIRING_SOON", days };
  return { status: "OK", days };
}

module.exports = { parseExpiry, expiryStatus };

// ---- quick self-test: node expiryParser.js ----
if (require.main === module) {
  const samples = [
    "MFG 08/25 EXP 08/27",
    "Exp. Date: AUG 2027",
    "B.No. A1234 MFG. JAN-2025 EXP. DEC-2026",
    "EXP: O3/2O28",
    "Use before 11.2027",
    "Price Rs 45 B.No 5567",
  ];
  for (const s of samples) console.log(JSON.stringify(s), "->", parseExpiry(s));
}
