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

const LOGO_BASE64 = "data:image/png;base64,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";

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
    <img src="${LOGO_BASE64}" alt="قرطبة للتوريدات" style="height:62px;width:auto;"/>
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
