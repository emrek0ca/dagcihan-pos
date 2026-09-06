/** ReceiptDocument -> ESC/POS baytlari */
import { EscPosBuilder, type EscPosOptions } from '../../hardware/printer/escpos.ts';
import type { ReceiptDocument } from './document.ts';

export function renderReceipt(doc: ReceiptDocument, options: EscPosOptions): Uint8Array {
  const b = new EscPosBuilder(options);
  const width = options.charactersPerLine;

  b.init();

  if (doc.simulated === true) {
    b.align('CENTER').bold(true).line('*** SIMULATOR - GECERSIZ FIS ***').bold(false);
  }

  b.align('CENTER').size(1, 1).bold(true).line(doc.storeName).bold(false).size(0, 0);
  for (const line of doc.storeLines) b.line(line);
  b.feed(1);

  if (doc.copy) {
    b.bold(true).line('*** KOPYA / TEKRAR BASIM ***').bold(false);
  }
  b.bold(true).line(doc.title).bold(false);
  b.align('LEFT').rule('=');

  for (const meta of doc.meta) b.columns(`${meta.label}:`, meta.value, width);
  b.rule('-');

  for (const line of doc.lines) {
    b.columns(line.name, line.amount, width);
    if (line.detail !== '') b.line(`  ${line.detail}`);
  }
  if (doc.lines.length > 0) b.rule('-');

  for (const row of doc.totals) {
    if (row.emphasize === true) {
      b.bold(true).size(1, 1);
      // Buyuk yazida satir genisligi yariya duser
      b.columns(row.label, row.value, Math.floor(width / 2));
      b.size(0, 0).bold(false);
    } else {
      b.columns(row.label, row.value, width);
    }
  }

  if (doc.payments.length > 0) {
    b.rule('-');
    for (const p of doc.payments) b.columns(p.label, p.value, width);
  }

  if (doc.taxRows.length > 0) {
    b.rule('-');
    b.line('KDV DOKUMU');
    b.columns('  Oran', 'Matrah / KDV', width);
    for (const t of doc.taxRows) b.columns(`  ${t.label}`, `${t.base} / ${t.tax}`, width);
  }

  b.rule('=');
  b.align('CENTER');
  for (const line of doc.footer) b.line(line);

  if (doc.barcodeData !== undefined && doc.barcodeData !== '') {
    b.feed(1).barcodeCode128(doc.barcodeData).feed(1).line(doc.barcodeData);
  }
  if (doc.qrData !== undefined && doc.qrData !== '') {
    b.feed(1).qr(doc.qrData);
  }

  if (doc.openDrawer === true) b.openDrawer();
  b.cut();
  return b.build();
}

/**
 * Kod sayfasi test sayfasi: ayni Turkce metni farkli `ESC t n` indeksleriyle basar.
 * Magazada dogru indeks gozle secilir ve config'e yazilir.
 */
export function renderCodePageTest(
  candidates: readonly { index: number; label: string; codePage: 'CP857' | 'CP1254' | 'ASCII' }[],
  charactersPerLine: number,
): Uint8Array {
  const sample = 'Turkce test: cigdem SIGA Ilgaz ÖĞÜT şĞİıçÜ 0123456789';
  const parts: number[] = [];
  for (const candidate of candidates) {
    const b = new EscPosBuilder({
      codePage: candidate.codePage,
      codePageIndex: candidate.index,
      charactersPerLine,
    });
    b.init().align('LEFT').bold(true).line(`--- ${candidate.label} ---`).bold(false);
    b.line(sample).feed(1);
    parts.push(...b.build());
  }
  const tail = new EscPosBuilder({ codePage: 'ASCII', codePageIndex: 0, charactersPerLine });
  tail.line('Dogru okunan satirin indeksini config/pos.config.json icine yazin.');
  tail.cut();
  parts.push(...tail.build());
  return Uint8Array.from(parts);
}
