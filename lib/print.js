import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import path from 'node:path';

const CM = 72 / 2.54;
const PAGE_W = 595.28, PAGE_H = 841.89; // A4
const FONT_DIR = path.resolve('fonts');

// Karten pro A4-Seite -> Raster und Kartengröße
export const LAYOUTS = {
  6: { cols: 2, rows: 3, cm: 8.5 },
  12: { cols: 3, rows: 4, cm: 6.5 },
  20: { cols: 4, rows: 5, cm: 4.8 },
  30: { cols: 5, rows: 6, cm: 3.8 },
};
export const DEFAULT_PER_PAGE = 12;

function layout(perPage) {
  const l = LAYOUTS[perPage] || LAYOUTS[DEFAULT_PER_PAGE];
  const card = l.cm * CM;
  return { ...l, card, k: l.cm / 6.5, mx: (PAGE_W - l.cols * card) / 2, my: (PAGE_H - l.rows * card) / 2, perPage: l.cols * l.rows };
}

// Pastellfarbe je nach Jahrzehnt/Jahr (Lösungsseite)
function yearColor(year) {
  const t = Math.max(0, Math.min(1, (year - 1950) / 80));
  const hue = Math.round(330 - t * 300); // pink -> lila -> blau -> grün -> gelb
  return hsl(hue, 0.65, 0.82);
}
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function fitText(doc, text, font, maxSize, minSize, width, maxHeight) {
  for (let s = maxSize; s >= minSize; s -= 0.5) {
    doc.font(font).fontSize(s);
    if (doc.heightOfString(text, { width, align: 'center' }) <= maxHeight) return s;
  }
  return minSize;
}

function centeredText(doc, text, font, maxSize, minSize, x, top, width, height) {
  const size = fitText(doc, text, font, maxSize, minSize, width, height);
  doc.font(font).fontSize(size);
  const h = Math.min(doc.heightOfString(text, { width, align: 'center' }), height);
  doc.text(text, x, top + (height - h) / 2, { width, height, align: 'center', ellipsis: true });
}

function cutLines(doc, L) {
  doc.save().lineWidth(0.4).strokeColor('#9a9a9a').dash(3, { space: 3 });
  for (let c = 0; c <= L.cols; c++) {
    const x = L.mx + c * L.card;
    doc.moveTo(x, 0).lineTo(x, PAGE_H).stroke();
  }
  for (let r = 0; r <= L.rows; r++) {
    const y = L.my + r * L.card;
    doc.moveTo(0, y).lineTo(PAGE_W, y).stroke();
  }
  doc.undash().restore();
}

function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  doc.save().fillColor('#000');
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // kleine Überlappung verhindert Haarlinien zwischen den Modulen
      if (qr.modules.get(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.15, cell + 0.15).fill();
    }
  }
  doc.restore();
}

// Alle Maße sind für 6,5-cm-Karten ausgelegt und werden mit L.k skaliert
function qrSide(doc, card, x, y, L) {
  const { k, card: size } = L;
  const qrSize = 4.3 * CM * k;
  drawQr(doc, card.url, x + (size - qrSize) / 2, y + 0.75 * CM * k, qrSize);
  doc.font('B').fontSize(Math.max(4.5, 8 * k)).fillColor('#555')
    .text('HIT-ZEITREISE', x, y + size - 1.05 * CM * k, { width: size, align: 'center', characterSpacing: 2 * k });
}

function solutionSide(doc, card, x, y, color, L) {
  const { k, card: size } = L;
  const inset = Math.max(0.2, 0.3 * k) * CM; // Rand gleicht leichten Versatz beim Duplexdruck aus
  const ix = x + inset, iy = y + inset, iw = size - 2 * inset;
  if (color) doc.save().roundedRect(ix, iy, iw, iw, 10 * k).fill(yearColor(card.year)).restore();
  else doc.save().lineWidth(0.6).strokeColor('#bbb').roundedRect(ix, iy, iw, iw, 10 * k).stroke().restore();
  const pad = 0.35 * CM * k, tw = iw - 2 * pad, boxH = 1.45 * CM * k;
  doc.fillColor('#1a1a1a');
  centeredText(doc, card.artist, 'B', 12 * k, Math.max(4.5, 6.5 * k), ix + pad, iy + pad, tw, boxH);
  doc.font('B').fontSize(46 * k);
  const yh = doc.heightOfString(String(card.year));
  doc.text(String(card.year), ix, iy + (iw - yh) / 2 + 2 * k, { width: iw, align: 'center' });
  centeredText(doc, card.title, 'I', 11 * k, Math.max(4.5, 6 * k), ix + pad, iy + iw - pad - boxH, tw, boxH);
}

/**
 * cards: [{ year, artist, title, url }], perPage: 6, 12, 20 oder 30 Karten pro Blatt.
 * Seite 1 = QR-Seite, Seite 2 = Lösungsseite (horizontal gespiegelt, Duplex über die lange Kante).
 */
export function renderCardsPdf(cards, { color = true, perPage = DEFAULT_PER_PAGE, title = 'Hit-Zeitreise Karten' } = {}) {
  const L = layout(perPage);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: title, Creator: 'Hit-Zeitreise' } });
  doc.registerFont('R', path.join(FONT_DIR, 'DejaVuSans.ttf'));
  doc.registerFont('B', path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('I', path.join(FONT_DIR, 'DejaVuSans-Oblique.ttf'));
  for (let s = 0; s < cards.length; s += L.perPage) {
    const sheet = cards.slice(s, s + L.perPage);
    doc.addPage();
    cutLines(doc, L);
    sheet.forEach((card, i) => qrSide(doc, card, L.mx + (i % L.cols) * L.card, L.my + Math.floor(i / L.cols) * L.card, L));
    doc.addPage();
    sheet.forEach((card, i) => {
      const col = L.cols - 1 - (i % L.cols); // gespiegelt
      solutionSide(doc, card, L.mx + col * L.card, L.my + Math.floor(i / L.cols) * L.card, color, L);
    });
  }
  doc.end();
  return doc;
}
