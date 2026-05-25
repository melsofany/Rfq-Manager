import puppeteer from "puppeteer";

export interface RfqPdfOptions {
  rfqNo: string;
  customerRfqNo: string;
  rfqDate?: string | null;
  closeDate: string;
  supplierName: string;
  contactPerson?: string | null;
  items: Array<{
    lineItem?: string | null;
    partNo?: string | null;
    description: string;
    qty?: string | null;
    uom?: string | null;
  }>;
  pricingUrl: string; // kept for API compatibility; not shown in PDF
  employeeName: string;
  employeePhone?: string | null;
  notes?: string | null;
}

function formatDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString("en-GB"); // DD/MM/YYYY
  } catch {
    return d;
  }
}

const LOGO_SVG = `<svg width="190" height="62" xmlns="http://www.w3.org/2000/svg">
  <rect width="190" height="62" fill="#1a3a5c" rx="6"/>
  <text x="95" y="22" font-family="Arial,sans-serif" font-size="9" font-weight="bold"
        fill="#c8a84b" text-anchor="middle" letter-spacing="3">CORTOBA SUPPLIES</text>
  <line x1="16" y1="30" x2="174" y2="30" stroke="#c8a84b" stroke-width="0.6" opacity="0.5"/>
  <text x="95" y="50" font-family="Arial,sans-serif" font-size="17" fill="#ffffff"
        text-anchor="middle">قرطبة للتوريدات</text>
</svg>`;

function buildHtml(opts: RfqPdfOptions): string {
  const rfqDate = opts.rfqDate
    ? formatDate(opts.rfqDate)
    : formatDate(new Date().toISOString());
  const closeDate = formatDate(opts.closeDate);

  const itemRows = opts.items
    .map((item, idx) => {
      const bg = idx % 2 === 0 ? "#ffffff" : "#f4f7fa";
      return `<tr style="background:${bg};">
        <td style="border:1px solid #d8e0e8;padding:7px 8px;text-align:center;color:#555;">${idx + 1}</td>
        <td style="border:1px solid #d8e0e8;padding:7px 8px;text-align:center;color:#333;">${item.partNo || "—"}</td>
        <td style="border:1px solid #d8e0e8;padding:7px 8px;text-align:right;color:#222;">${item.description}</td>
        <td style="border:1px solid #d8e0e8;padding:7px 8px;text-align:center;color:#333;">${item.qty || "—"}</td>
        <td style="border:1px solid #d8e0e8;padding:7px 8px;text-align:center;color:#333;">${item.uom || "—"}</td>
      </tr>`;
    })
    .join("");

  const notesHtml = opts.notes?.trim()
    ? `<div style="margin-top:18px;background:#f0f4f8;border-right:4px solid #1a3a5c;
                   padding:10px 14px;border-radius:4px;">
         <div style="font-size:10px;color:#888;margin-bottom:4px;">ملاحظات:</div>
         <div style="font-size:12px;color:#333;line-height:1.7;">${opts.notes.trim()}</div>
       </div>`
    : "";

  const supplierLine = opts.contactPerson
    ? `${opts.supplierName} &mdash; ${opts.contactPerson}`
    : opts.supplierName;

  const contactParts = [opts.employeeName, opts.employeePhone, "INFO@CORTOBA-SUPPLIES.COM"]
    .filter(Boolean)
    .join(" &nbsp;|&nbsp; ");

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, "Noto Sans Arabic", "DejaVu Sans", sans-serif;
      font-size: 12px;
      color: #1a1a1a;
      direction: rtl;
    }

    /* ── HEADER ── */
    .header {
      background: #1a3a5c;
      padding: 14px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-title { direction: ltr; text-align: left; }
    .header-title h1 { font-size: 20px; color: #ffffff; font-weight: bold; }
    .header-title p  { font-size: 9px; color: #c8a84b; letter-spacing: 2.5px; margin-top: 4px; }

    /* ── INFO BAND ── */
    .info-band {
      display: flex;
      justify-content: space-around;
      background: #eef2f7;
      border-bottom: 2.5px solid #c8a84b;
      padding: 10px 20px;
    }
    .info-cell { text-align: center; }
    .info-cell .lbl { font-size: 9px; color: #8899aa; margin-bottom: 3px; }
    .info-cell .val { font-size: 12px; font-weight: bold; color: #1a3a5c; }

    /* ── CONTENT ── */
    .content { padding: 18px 22px 14px; }

    .to-label  { font-size: 10px; color: #8899aa; margin-bottom: 2px; }
    .to-name   { font-size: 15px; font-weight: bold; color: #1a3a5c; margin-bottom: 6px; }
    .intro     { font-size: 11px; color: #555; line-height: 1.7; margin-bottom: 14px; }

    /* ── TABLE ── */
    table { width: 100%; border-collapse: collapse; }
    thead th {
      background: #1a3a5c;
      color: #ffffff;
      font-size: 11px;
      font-weight: bold;
      padding: 8px;
      border: 1px solid #1a3a5c;
    }
    tbody td { font-size: 11px; }

    /* ── FOOTER ── */
    .footer {
      margin-top: 22px;
      border-top: 2px solid #c8a84b;
      padding-top: 8px;
      text-align: center;
      font-size: 10px;
      color: #777;
    }
  </style>
</head>
<body>

  <!-- HEADER -->
  <div class="header">
    ${LOGO_SVG}
    <div class="header-title">
      <h1>طلب عرض سعر</h1>
      <p>REQUEST FOR QUOTATION</p>
    </div>
  </div>

  <!-- INFO BAND -->
  <div class="info-band">
    <div class="info-cell">
      <div class="lbl">رقم الطلب الداخلي</div>
      <div class="val">${opts.rfqNo}</div>
    </div>
    <div class="info-cell">
      <div class="lbl">رقم RFQ العميل</div>
      <div class="val">${opts.customerRfqNo}</div>
    </div>
    <div class="info-cell">
      <div class="lbl">تاريخ الإصدار</div>
      <div class="val">${rfqDate}</div>
    </div>
    <div class="info-cell">
      <div class="lbl">آخر موعد للتقديم</div>
      <div class="val">${closeDate}</div>
    </div>
  </div>

  <!-- BODY -->
  <div class="content">

    <div class="to-label">إلى المورّد:</div>
    <div class="to-name">${supplierLine}</div>
    <div class="intro">
      يسرنا الاستفسار عن أسعار الأصناف التالية، ونرجو التفضل بتزويدنا
      بأفضل عروض الأسعار قبل التاريخ المحدد أعلاه.
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:36px;text-align:center;">#</th>
          <th style="width:105px;text-align:center;">رقم القطعة</th>
          <th style="text-align:right;">الوصف</th>
          <th style="width:62px;text-align:center;">الكمية</th>
          <th style="width:58px;text-align:center;">الوحدة</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    ${notesHtml}

    <div class="footer">${contactParts}</div>
  </div>

</body>
</html>`;
}

export function generateRfqPdf(opts: RfqPdfOptions): Promise<Buffer> {
  return (async () => {
    const html = buildHtml(opts);

    const browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({
        format: "A4",
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
        printBackground: true,
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  })();
}
