import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import path from 'node:path';

const CM = 72 / 2.54;
const PAGE_W = 595.28, PAGE_H = 841.89; // A4
export const CARD = 6.5 * CM;
export const COLS = 3, ROWS = 4, PER_SHEET = COLS * ROWS;
const MX = (PAGE_W - COLS * CARD) / 2;
const MY = (PAGE_H - ROWS * CARD) / 2;
const FONT_DIR = path.resolve('fonts');

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

function cutLines(doc) {
  doc.save().lineWidth(0.4).strokeColor('#9a9a9a').dash(3, { space: 3 });
  for (let c = 0; c <= COLS; c++) {
    const x = MX + c * CARD;
    doc.moveTo(x, 0).lineTo(x, PAGE_H).stroke();
  }
  for (let r = 0; r <= ROWS; r++) {
    const y = MY + r * CARD;
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

function qrSide(doc, card, x, y) {
  const qrSize = 4.3 * CM;
  drawQr(doc, card.url, x + (CARD - qrSize) / 2, y + 0.75 * CM, qrSize);
  doc.font('B').fontSize(8).fillColor('#555')
    .text('HIT-ZEITREISE', x, y + CARD - 1.05 * CM, { width: CARD, align: 'center', characterSpacing: 2 });
}

function solutionSide(doc, card, x, y, color) {
  const inset = 0.3 * CM; // Rand gleicht leichten Versatz beim Duplexdruck aus
  const ix = x + inset, iy = y + inset, iw = CARD - 2 * inset;
  if (color) doc.save().roundedRect(ix, iy, iw, iw, 10).fill(yearColor(card.year)).restore();
  else doc.save().lineWidth(0.6).strokeColor('#bbb').roundedRect(ix, iy, iw, iw, 10).stroke().restore();
  const pad = 0.35 * CM, tw = iw - 2 * pad;
  doc.fillColor('#1a1a1a');
  centeredText(doc, card.artist, 'B', 12, 6.5, ix + pad, iy + pad, tw, 1.45 * CM);
  doc.font('B').fontSize(46);
  const yh = doc.heightOfString(String(card.year));
  doc.text(String(card.year), ix, iy + (iw - yh) / 2 + 2, { width: iw, align: 'center' });
  centeredText(doc, card.title, 'I', 11, 6, ix + pad, iy + iw - pad - 1.45 * CM, tw, 1.45 * CM);
}

/**
 * cards: [{ year, artist, title, url }], sheets mit je 12 Karten.
 * Seite 1 = QR-Seite, Seite 2 = Lösungsseite (horizontal gespiegelt, Duplex über die lange Kante).
 */
export function renderCardsPdf(cards, { color = true, title = 'Hit-Zeitreise Karten' } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: title, Creator: 'Hit-Zeitreise' } });
  doc.registerFont('R', path.join(FONT_DIR, 'DejaVuSans.ttf'));
  doc.registerFont('B', path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('I', path.join(FONT_DIR, 'DejaVuSans-Oblique.ttf'));
  for (let s = 0; s < cards.length; s += PER_SHEET) {
    const sheet = cards.slice(s, s + PER_SHEET);
    doc.addPage();
    cutLines(doc);
    sheet.forEach((card, i) => qrSide(doc, card, MX + (i % COLS) * CARD, MY + Math.floor(i / COLS) * CARD));
    doc.addPage();
    sheet.forEach((card, i) => {
      const col = COLS - 1 - (i % COLS); // gespiegelt
      solutionSide(doc, card, MX + col * CARD, MY + Math.floor(i / COLS) * CARD, color);
    });
  }
  doc.end();
  return doc;
}
