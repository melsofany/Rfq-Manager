import nodemailer from "nodemailer";
import { logger } from "./logger";

const SMTP_TIMEOUT_MS = 10000;

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    requireTLS: Number(process.env.SMTP_PORT) !== 465,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

export async function verifyEmailConnection(): Promise<{ ok: boolean; error?: string }> {
  const transporter = createTransporter();
  try {
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendRfqEmail(opts: {
  to: string;
  toName: string;
  rfqNo: string;
  items: Array<{ lineItem?: string | null; partNo?: string | null; description: string; qty?: string | null; uom?: string | null }>;
  pricingUrl: string;
  closeDate: string;
  employeeName: string;
  employeePhone?: string | null;
}): Promise<void> {
  const transporter = createTransporter();
  const senderEmail = (process.env.SMTP_USER || "info@cortoba-supplies.com").toLowerCase();

  const itemRows = opts.items
    .map(
      (item, i) => `
    <tr style="background:${i % 2 === 0 ? "#f9fafb" : "#ffffff"}">
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${item.lineItem || i + 1}</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${item.partNo || "-"}</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb">${item.description}</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center">${item.qty || "-"}</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center">${item.uom || "-"}</td>
    </tr>`,
    )
    .join("");

  const html = `
<!DOCTYPE html>
<html dir="ltr" lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RFQ ${opts.rfqNo} - Request for Quotation</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f3f4f6">
  <div style="max-width:700px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="background:#1e3a5f;padding:20px 32px">
      <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700">Cortoba Supplies</h1>
      <p style="margin:4px 0 0;color:#93c5fd;font-size:13px">قرطبة للتوريدات</p>
    </div>
    <div style="padding:32px">
      <p style="margin:0 0 8px;font-size:15px;color:#374151">Dear <strong>${opts.toName}</strong>,</p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151">
        We would like to request your best quotation for the following items.<br>
        <strong>RFQ Reference:</strong> ${opts.rfqNo} &nbsp;|&nbsp; <strong>Closing Date:</strong> ${opts.closeDate}
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
        <thead>
          <tr style="background:#1e3a5f;color:#ffffff">
            <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left">Line</th>
            <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left">Part No</th>
            <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:left">Description</th>
            <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:center">QTY</th>
            <th style="padding:10px 12px;border:1px solid #1e3a5f;text-align:center">UOM</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div style="text-align:center;margin:32px 0">
        <a href="${opts.pricingUrl}"
           style="background:#1e3a5f;color:#ffffff;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600;display:inline-block">
          Submit Your Quotation
        </a>
      </div>
      <p style="font-size:13px;color:#374151;text-align:center;margin-top:8px">
        Or copy this link into your browser:<br>
        <a href="${opts.pricingUrl}" style="color:#1e3a5f;word-break:break-all">${opts.pricingUrl}</a>
      </p>
      <p style="font-size:12px;color:#6b7280;text-align:center;margin-top:16px">
        This link is unique to your company. Please do not share it.<br>
        The link expires on <strong>${opts.closeDate}</strong>.
      </p>
    </div>
    <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px">
      <p style="margin:0 0 4px;font-size:13px;color:#6b7280">
        Contact: <strong>${opts.employeeName}</strong>${opts.employeePhone ? " &nbsp;|&nbsp; " + opts.employeePhone : ""}
        &nbsp;|&nbsp; <a href="mailto:${senderEmail}" style="color:#1e3a5f">${senderEmail}</a>
      </p>
      <p style="margin:0;font-size:11px;color:#9ca3af">
        ش.الاسكندرية - برج نجمة مطروح الدور الرابع - مرسي مطروح
        &nbsp;&nbsp;|&nbsp;&nbsp; ب-ض: 432-972-587 &nbsp;&nbsp;|&nbsp;&nbsp; س-ت: 21618
      </p>
    </div>
  </div>
</body>
</html>`;

  const itemsText = opts.items
    .map((item, i) =>
      `  ${item.lineItem || i + 1}. ${item.description}${item.partNo ? " [" + item.partNo + "]" : ""} — QTY: ${item.qty || "-"} ${item.uom || ""}`.trim()
    )
    .join("\n");

  const text = `
Dear ${opts.toName},

Cortoba Supplies (قرطبة للتوريدات) would like to request your best quotation for the following items.

RFQ Reference : ${opts.rfqNo}
Closing Date  : ${opts.closeDate}

ITEMS
-----
${itemsText}

To submit your quotation, please visit:
${opts.pricingUrl}

This link is unique to your company. Please do not share it.
It expires on ${opts.closeDate}.

---
${opts.employeeName}${opts.employeePhone ? " | " + opts.employeePhone : ""}
${senderEmail}
Cortoba Supplies — ش.الاسكندرية - برج نجمة مطروح الدور الرابع - مرسي مطروح
`.trim();

  try {
    await transporter.sendMail({
      from: `"Cortoba Supplies قرطبة للتوريدات" <${senderEmail}>`,
      replyTo: `"${opts.employeeName}" <${senderEmail}>`,
      to: `"${opts.toName}" <${opts.to}>`,
      subject: `Request for Quotation — ${opts.rfqNo} (Closing: ${opts.closeDate})`,
      text,
      html,
      headers: {
        "X-Priority": "1",
        "X-Mailer": "Cortoba-RFQ-System",
      },
    });
    logger.info({ to: opts.to, rfqNo: opts.rfqNo }, "RFQ email sent successfully");
  } finally {
    transporter.close();
  }
}
