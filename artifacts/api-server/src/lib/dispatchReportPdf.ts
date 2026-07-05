import PDFDocument from 'pdfkit';

export interface DispatchSupplier {
  supplierName: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  linkOpened: boolean;
  openCount: number;
  offerSubmitted: boolean;
  createdAt: string;
}

export interface DispatchReportOptions {
  rfqNo: string;
  customerRfqNo: string;
  exportDate: string;
  suppliers: DispatchSupplier[];
}

// Cortoba logo — same base64 blob used in rfqPdf.ts
const LOGO_BASE64 =
  'data:image/png;base64,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';

function getLogoBuffer(): Buffer {
  return Buffer.from(LOGO_BASE64.replace('data:image/png;base64,', ''), 'base64');
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB');
  } catch {
    return iso;
  }
}

function channelLabel(s: DispatchSupplier): string {
  const hasPhone = !!(s.phone?.trim());
  const hasEmail = !!(s.email?.trim());
  if (hasPhone && hasEmail) return 'WA + Email';
  if (hasPhone) return 'WhatsApp';
  if (hasEmail) return 'Email';
  return '-';
}

/**
 * Generate the dispatch-report PDF and return it as a Buffer.
 * Stream listeners are attached BEFORE any content is written — safe PDFKit pattern.
 */
export function generateDispatchReportPdf(opts: DispatchReportOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
      info: {
        Title: `Dispatch Report - ${opts.rfqNo}`,
        Author: 'Cortoba Supplies',
      },
    });

    // Attach stream listeners BEFORE writing content
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };
    doc.on('data',  (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on('end',   ()              => settle(() => resolve(Buffer.concat(chunks))));
    doc.on('error', (err: Error)    => settle(() => reject(err)));

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const M      = 28;
    const CW     = PAGE_W - M * 2;

    const BLUE    = '#1a3a5c';
    const GOLD    = '#c8a84b';
    const GREY_BG = '#eef2f7';
    const GREEN   = '#1a7a4a';
    const AMBER   = '#b45309';
    const WHITE   = '#ffffff';
    const LIGHT   = '#f4f8fc';
    const BORDER  = '#d0dbe8';

    function drawHeader(yStart: number): number {
      const H = 70;
      doc.rect(0, yStart, PAGE_W, H).fill(BLUE);
      try { doc.image(getLogoBuffer(), PAGE_W - M - 58, yStart + 7, { height: 56 }); } catch { /* skip */ }
      doc.font('Helvetica-Bold').fontSize(18).fillColor(WHITE)
        .text('Dispatch Report - RFQ', M, yStart + 14, { lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(GOLD)
        .text('RFQ SEND LOG  |  Cortoba Supplies', M, yStart + 44, { lineBreak: false });
      return yStart + H;
    }

    function drawInfoBar(yStart: number): number {
      const H = 46;
      doc.rect(0, yStart, PAGE_W, H).fill(GREY_BG);
      doc.rect(0, yStart + H - 2, PAGE_W, 2).fill(GOLD);
      const cells = [
        { label: 'Internal RFQ No',  value: opts.rfqNo },
        { label: 'Customer RFQ No',  value: opts.customerRfqNo || '-' },
        { label: 'Export Date',       value: opts.exportDate },
        { label: 'Total Suppliers',   value: String(opts.suppliers.length) },
      ];
      const cellW = CW / cells.length;
      cells.forEach((c, i) => {
        const cx = M + i * cellW;
        doc.font('Helvetica').fontSize(7).fillColor('#7a8fa6')
          .text(c.label, cx, yStart + 7,  { width: cellW, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE)
          .text(c.value, cx, yStart + 22, { width: cellW, align: 'center', lineBreak: false });
      });
      return yStart + H;
    }

    function drawFooter(): void {
      const fy = PAGE_H - 22;
      doc.rect(0, fy, PAGE_W, 22).fill(BLUE);
      doc.font('Helvetica').fontSize(8).fillColor(GOLD)
        .text('Cortoba Supplies  |  INFO@CORTOBA-SUPPLIES.COM', M, fy + 7,
          { width: CW, align: 'center', lineBreak: false });
    }

    const ROW_H    = 24;
    const COL_W    = [26, 124, 88, 88, 72, 52, 46] as const;
    const lastW    = CW - (COL_W as unknown as number[]).reduce((a, b) => a + b, 0);
    const colWidths = [...COL_W, lastW];
    const colLabels = ['#', 'Supplier', 'Contact', 'Phone', 'Method', 'Opened', 'Offer', 'Sent'];

    function drawTableHeader(yStart: number): number {
      doc.rect(M, yStart, CW, ROW_H).fill(BLUE);
      let tx = M;
      colLabels.forEach((h, i) => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE)
          .text(h, tx + 2, yStart + 8, { width: colWidths[i] - 4, align: 'center', lineBreak: false });
        tx += colWidths[i];
      });
      return yStart + ROW_H;
    }

    try {
      let y = drawHeader(0);
      y = drawInfoBar(y);
      y += 10;

      doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE)
        .text('Suppliers who received this RFQ', M, y, { width: CW, lineBreak: false });
      y += 20;
      y = drawTableHeader(y);

      opts.suppliers.forEach((s, idx) => {
        if (y + ROW_H > PAGE_H - 50) {
          drawFooter();
          doc.addPage({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = drawHeader(0);
          y += 6;
          y = drawTableHeader(y);
        }

        const rowBg = idx % 2 === 0 ? WHITE : LIGHT;
        doc.rect(M, y, CW, ROW_H).fill(rowBg).strokeColor(BORDER).lineWidth(0.4).stroke();

        const method      = channelLabel(s);
        const methodColor =
          method === 'WA + Email' ? BLUE
          : method === 'WhatsApp' ? GREEN
          : method === 'Email'    ? AMBER
          : '#999999';

        const cells = [
          { text: String(idx + 1),                              color: '#666666',  align: 'center' as const },
          { text: s.supplierName || '-',                        color: '#111827',  align: 'left'   as const },
          { text: s.contactPerson || '-',                       color: '#555555',  align: 'left'   as const },
          { text: s.phone || '-',                               color: BLUE,       align: 'center' as const },
          { text: method,                                       color: methodColor, align: 'center' as const },
          { text: s.linkOpened ? `Yes (${s.openCount})` : 'No',
            color: s.linkOpened ? GREEN : '#aaaaaa', align: 'center' as const },
          { text: s.offerSubmitted ? 'Yes' : 'No',
            color: s.offerSubmitted ? GREEN : '#aaaaaa', align: 'center' as const },
          { text: fmtDate(s.createdAt),                         color: '#666666',  align: 'center' as const },
        ];

        let tx = M;
        cells.forEach((cell, i) => {
          doc.font('Helvetica').fontSize(8.5).fillColor(cell.color)
            .text(cell.text, tx + 3, y + 7, { width: colWidths[i] - 6, align: cell.align, lineBreak: false });
          tx += colWidths[i];
        });
        y += ROW_H;
      });

      y += 8;
      if (y + 32 > PAGE_H - 50) {
        drawFooter();
        doc.addPage({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        y = 20;
      }

      const waCount    = opts.suppliers.filter(s => s.phone?.trim()).length;
      const emailCount = opts.suppliers.filter(s => s.email?.trim()).length;
      const opened     = opts.suppliers.filter(s => s.linkOpened).length;
      const submitted  = opts.suppliers.filter(s => s.offerSubmitted).length;

      doc.rect(M, y, CW, 28).fill(GREY_BG).strokeColor(BORDER).lineWidth(0.4).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(BLUE)
        .text(
          `Total: ${opts.suppliers.length}   |   WhatsApp: ${waCount}   |   Email: ${emailCount}   |   Link opened: ${opened}   |   Offer submitted: ${submitted}`,
          M + 4, y + 9, { width: CW - 8, align: 'center', lineBreak: false },
        );

      drawFooter();
      doc.end();

    } catch (buildErr) {
      settle(() => reject(buildErr as Error));
    }
  });
}