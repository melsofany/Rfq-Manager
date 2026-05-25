import PDFDocument from "pdfkit";
  import { readFileSync } from "fs";
  import { resolve, dirname } from "path";
  import { fileURLToPath } from "url";

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
    pricingUrl: string;
    employeeName: string;
    employeePhone?: string | null;
    notes?: string | null;
  }

  function formatDate(d: string): string {
    try {
      return new Date(d).toLocaleDateString("en-GB");
    } catch {
      return d;
    }
  }

  const LOGO_BASE64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAABHNCSVQICAgIfAhkiAAAAF96VFh0UmF3IHByb2ZpbGUgdHlwZSBBUFAxAAAImeNKT81LLcpMVigoyk/LzEnlUgADYxMuE0sTS6NEAwMDCwMIMDQwMDYEkkZAtjlUKNEABZgamFmaGZsZmgMxiM8FAEi2FMk61EMyAAANfElEQVRoge1ZeXhV1bX/rX2GOyU3QEIikRmKtJ/0oRBkDigEAgIylEEpAkJ9SGVQhAIiZbBQGeTV0hahfsprQdS+QoHKKDEM+hTRiqiAECQMCZA5dzrn7L3eHzc3Bkwgqfi+932vvz/ud/c6a639+529z9pn7wP8C/8P8PXzk9rkL+p79PvILb6PpDciIXjuUFygoEPhshE/ud256yRgwqbfG2eH9f1VXWLyF2dOEaqgodQYetnFN+pG79aok4BXSjzuhEDJ3ILMznz5wd4LahPjCpet1ZSAUBqILRTM6TPvn6NaPeok4IO921rqLKFJBbcdWnxlQI+SszP/vVtN/rlLhs82ZJAUKGpgDYZWvvBmffCpXFGwd/za2nKqk4DUpg2Egg6AQMwwnbA/6cRHh66MyKh2WvkiV36uiKAxAwCIFTRpm+d+OXZ0df6FezLmh04PknHh4098LwKUtIjAlW0mgCFglJbMvTaw956qvl9umNVMl8EmxAKySi8Mgs86O66q71dHFyUFt/fN8wcvLTUdu4LUOP22CwicixQCClQxJYgFGAAB0O1A38KBfY7FfH25n2fqiqOUmapkYWgkMmOtnLfHdUnN/+tVl5OXwgIAERgEYKNz2wUcGZqRp0gDVxmFb0CALLznWub9hwDAo6yBKnaFACKq9DNkAB+NH9Ai98iUe1LtE0dMm6GEBJjAzJDXCb45au9ZgfzMbsrjOKSqiVQUnefB1OZ/8jW7NkwPl3oBApEAEaBUVBKzg9CPem30pewb54nokMKOzkcARAybkgs9gw4k1oZPnRcyAh2v+Vr011VQNFw2S1sNSDAEmCWUik49BqB0b7mTeC7LHZGQZIOgVY4QM6CgDtaWT50F2C7foeqnEEAMEAhShk4nTnxhQcidcllAVV53BEOAca1+swH+BO0ECwJAYFbgWKUCENbj9lTbwe0QENBdW6WQIEb1MphhuhKCAHCxXnJ6jCQQrUCOy5/d6pnNByPK9HwzgwkQAsQMCYG959ttBoDi81saydPpvUInH5sYPD12aujLp6eUnxnUpmp3tKpD54gmdFNJCQCQpgblKFvXjTOS+HNbE+/D7ds7f9/OT2JBxRldWAoHuopVjOsRgvl+oz0HuwBA8cIeO41wcACDAFLI96e1bDVvXU7ZrowH3JGL+4gEoAQ0hBESLnDcvV+gqdqqO8EZgso9AhJgBoNBpFBELbontXnlcKwvXRGZzArQCMSAbis4JAyWkbYay7aGpQ8TQQsr0rpCmO4dX0h6PpBa7wPvpZxOQplwhADgVJZWMMNM8FeqKmzw45kNLx8dAJZQZsr7reatywEAaYUTAFHx5AcRMFt+FhAZw+q3fr+nCBZvYGEDrIOZwCRBbMAm/4dVyQOAULoW0JhBFfNBESCgQCwAGFBEcAQgGEA4/OBddvC9P16KnIgkJj0Y8pjXQKFvyAMAEexQUXys2XL62lMh3XNOYwdXDf8fK910/W4NCramocBMHx+XubtdSr+nT1MwsgFgkDIrODGIDQCEfKPDqBtHWziavoCJKxekm0EKQAPBXXx1wh2b9+xM3p7dUHpSpiihQ4nogkXMMDS96XWBGq2N6F60XrBlQ6WASF4nS/METqYMT07J3PAaAIQ+z9wQHc3oo8kQYFLQJKHcbDSrWYtnc74lYP7hrBdZmEFUqRY1QeNouXY5jOX9BjwHAElbd/0he8w0Fwn/YSksSCEBy46rGufoyXsBOnZdLrNxJ/fAD+Pad3r2KgBcOz4h3RDqMYJdcScZTBK6NBE2/a/Va/nqquo4CQAoT6zXn8BQtVzXbCFgFJUtQkXpe+jRUVb9v+/rHohPXcwkINjB10MeaRvzT12w5R9BT8q2WPvMvolNzvvb/BgVtf/sFxObJpj5WYADJhck4qGEF4J1lGr1X/f84M3xNXERALDw7b8dVJ64Pwt161EAEB1iJbG8Z58NVe1N3tqxsKxe40G6BCxXUZ+q1woSu6yL/W/V55XcH/b4bR4AnP5yy70pBi8JiaYjvwotc61ss10Ybd4Szg+2iq8aL3cn3LV5zM25VMHKLun5wraSAaphqfp2tHVHYru527d/VtWcM3JgZlxp2XMNd2V3qU2a74LrFrIXE/2tiQiqdvTBDOj5RYdutLd4Y+fbZQ1TXlne517PbeJZI64TcHHH9rJgyxatQRRlV4tnwnCchOU9eu+80d7yP99cn/joI+HbR7V6VMtw9RNPtlMffvQp1VIEA3DifQt/cWDv4tvM75aokd2cwYNTk/ILLwipCBqBlKYo+hLNDpgIgoTjgAVALKFA0JNSJszY/bdX//fo3+L2DtqxURtSpGjST8dXuztaNn5CEl3Iay/DTmfTifQVyu5pJiRNf3Lv9t98P3S/jVoV/qX9+ncwSyMz9Qb1fvnUzr9+tbpXv1lkyUYzj+x7+kbfFZ37jbRap5ya/6eNnwDAkm7px/WQdTcAWA3inlm4b+/KuhB8qmevCYYj0zsOG/z4T2Y9E5nZtdsflOk98R9Ze1+qtYAXOvdgMyIRdNNJkZr6iHHuwlEACHp9cxcc3Lf8ZrEremVs4pKyMYqBstSkjs//fftHtSX/5NiHG8cdP5WrAHBc3PpAMHzBZGuRkAJ5Dbyd/vxu9oe12g8oQ1wEKXg119mI13eaBUVf4XXj5K1irUCkoQQBGqEu5AGA/P4rUkT3cZLwqe7z5igmOIaA1+U7X5dcWHH/oAdi/5f1f6jxrzOH3l2buKUdO/PSjmm8pHP6F3XqsALTRoxqOLvvgPRY+6mMwd1/PnBQk1j7llNo3aBRzUPXroyzHasZsTKF21sudTru9njNwjjf+oVvbg4AwKohQ2c5rHRZGjo2L2tP5ZZw6cix7TW7CLhSmGRJkcxKKNOn5807cCAr5jO9fVpCnFL9HUEWE2lOgu/M6qysjwHgub6D218tzR/hUvxvLKkEpnlszXvZq2N76JsKeD5jwHR3YdEamxy4XP6TGvCxtK3hUkYMUjrco4d4ps6eE37moaEt7jiXd1aSBHvjX55zeP/jS7ul/0xYah3LCBgSbMZB0zTHCQV1Zglbp4B/cGby7AWLgrP6D8kQBXm7NUdBKQWR4J+2LPvAS9O79vyLVl42DGSCk+IXRkLhh6is/B7l8uKHQ4e7p81/OlLjM7Bk6PC23oLSNcwKZkLKxpmH9reddmj/GDKMMANwXFrh1NlzwgDQoCjU1REOiDSUE+8DgPz4uMOWR98iFEEpAatZ07R5h98xfHfdNdoGAEm+0h3vzACAlbu27SG261mHFWww/I2b7JjSudtUDpQPk9DgtG3V68X9+xZ7mjYfbBNB2mF8uu2tucBNNvVa/tVf2cKCYIE7enWZBgBrli5NcMKheAJBQXwQ841wpBuDIFkBTRq/BwAv7dp5gmznTgcEaDoWv77xYwCwI+XXFADFCo7bVdkfS/RTCpCGjrmbNuaYEfsFFgC5XaW/2bLpXQBQHAEzQbGCUNTkpgK8TEMJEnp8/OWHn51fAgD0wWedAQlNKcDnqzy7McKh3goAmy4s2bzxQswuLNXVIQXh9VwlIgkA5UVlXQmInsC5zMqqZEciXQEAJM4+O+XxFCUtr5ICyuPeEfNxyoMtFaJHMJquXalRwC/Gj28irTCIdVgavRuzh4pLujELKCVQqMtKAUxGW4aATfIfMducseOSbGULYobUqPKN1bas7ooZTIBKangIAOY8Oq4+S0uTxNCEkRU6e7GnhABYwTGqxJYHO0kCFBMCbvFJjQISTl9qBZLRPa5mnqq807rsSYphCYGWI0f8NwCsGj2mNWwbDEAIvVKs62Jud8HRsyDhjj8Ss2vEncEK7HYFVm16LQAAxSdz0sEVBxTxnuzA1aK2BEAxwDp9XikgbA1gBmyh0Lx32vYaBZR7XaWa0iBYwoFTWanCxWXNHNLAhiGnTJxsAUDJ5au9wAxmRsBtvhfzjdjclQFIxeD6vncAYOeB3YYMBv0OEaSD7JivqWQnBUBJIOR1Z8OgaxIMCcDjTygDAGYmJxLprRSDdSNr8cKVQeAmZXTFfT2LNdtKsN1G2PB6J8cHQoVFHtdaWVjaHLoCmZ55WmnghOPzTnMi1gPMjEhy/SFlZUW5LinChu56SwSDPwIByfe262fZdnlZWSAtkPP1GpsI0PSdyXe3fWz+a6/mz+je46BdEuiuNAEtuX5apCR4pwwFt5ICRIOE193JiXPLcy+/7pSV3qcMF3vv6+Rf//Lvy28qoOfose7+X+e+bNp2ps1OEhNBJyNXGnRWOtyGbNlICYCVshSRzcxgwAcAihggUhJwAIYtlckAmAgQJBUrycymHR8/6nfZWW9M7ZAm2baFEoAjtOhhFtiKDZAtGUzIc9zGX/pOnjTjsUmTK9+O63y8fruxfPyk1JxjRy+CFJQvYf36Iwd/Vpf4Wn3GqQkPnz5PLcaNyiVWd9qpzVr/+r/eOFPXHOdyTj7BxGClw25Yr06fcIHv+KE7cfK4B90BdSdCAmZJ8eN1jb+/70AvykPzlWJwcsP5r27bfq6uOb6TgJc69tsR8rousItwSTm1/jQaQ8s4nxYBCux69X+6Yf/uOt/9f+H/Av4HNR8m1l+J+FIAAAAASUVORK5CYII=";

  function getLogoBuffer(): Buffer {
    const base64 = LOGO_BASE64.replace("data:image/png;base64,", "");
    return Buffer.from(base64, "base64");
  }

  function getFontPath(): string {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    return resolve(currentDir, "assets/fonts/Amiri-Regular.ttf");
  }

  export function generateRfqPdf(opts: RfqPdfOptions): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      try {
        const fontPath = getFontPath();

        const doc = new PDFDocument({
          size: "A4",
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          autoFirstPage: true,
          bufferPages: true,
        });

        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.registerFont("Amiri", fontPath);

        const PAGE_W = doc.page.width;
        const MARGIN = 30;
        const CONTENT_W = PAGE_W - MARGIN * 2;
        const BLUE = "#1a3a5c";
        const GOLD = "#c8a84b";
        const GREY_BG = "#eef2f7";

        const rfqDate = opts.rfqDate
          ? formatDate(opts.rfqDate)
          : formatDate(new Date().toISOString());
        const closeDate = formatDate(opts.closeDate);

        // ── HEADER BAND ──────────────────────────────────────────────────────
        doc.rect(0, 0, PAGE_W, 80).fill(BLUE);

        // Logo (top-right, since document is RTL visually)
        const logoBuffer = getLogoBuffer();
        doc.image(logoBuffer, PAGE_W - MARGIN - 62, 9, { height: 62 });

        // Title text (left side of header = right in RTL view)
        doc.font("Amiri").fontSize(22).fillColor("#ffffff")
          .text("طلب عرض سعر", MARGIN, 16, { lineBreak: false });
        doc.font("Amiri").fontSize(9).fillColor(GOLD)
          .text("REQUEST FOR QUOTATION", MARGIN, 48, { lineBreak: false });

        // ── INFO BAND ─────────────────────────────────────────────────────────
        const INFO_Y = 80;
        const INFO_H = 52;
        doc.rect(0, INFO_Y, PAGE_W, INFO_H).fill(GREY_BG);
        doc.rect(0, INFO_Y + INFO_H - 2.5, PAGE_W, 2.5).fill(GOLD);

        const infoCells = [
          { label: "رقم الطلب الداخلي", value: opts.rfqNo },
          { label: "رقم RFQ العميل", value: opts.customerRfqNo },
          { label: "تاريخ الإصدار", value: rfqDate },
          { label: "آخر موعد للتقديم", value: closeDate },
        ];

        const cellW = CONTENT_W / infoCells.length;
        infoCells.forEach((cell, i) => {
          const cx = MARGIN + i * cellW;
          doc.font("Amiri").fontSize(8).fillColor("#8899aa")
            .text(cell.label, cx, INFO_Y + 8, {
              width: cellW,
              align: "center",
              lineBreak: false,
            });
          doc.font("Amiri").fontSize(12).fillColor(BLUE)
            .text(cell.value, cx, INFO_Y + 26, {
              width: cellW,
              align: "center",
              lineBreak: false,
            });
        });

        // ── BODY ──────────────────────────────────────────────────────────────
        let y = INFO_Y + INFO_H + 14;

        // To-supplier line
        const supplierLine = opts.contactPerson
          ? `${opts.supplierName} — ${opts.contactPerson}`
          : opts.supplierName;

        doc.font("Amiri").fontSize(9).fillColor("#8899aa")
          .text("إلى المورّد:", MARGIN, y, {
            width: CONTENT_W,
            align: "right",
            lineBreak: false,
          });
        y += 16;

        doc.font("Amiri").fontSize(15).fillColor(BLUE)
          .text(supplierLine, MARGIN, y, {
            width: CONTENT_W,
            align: "right",
            lineBreak: false,
          });
        y += 26;

        doc.font("Amiri").fontSize(10).fillColor("#555555")
          .text(
            "يسرنا الاستفسار عن أسعار الأصناف التالية، ونرجو التفضل بتزويدنا بأفضل عروض الأسعار قبل التاريخ المحدد أعلاه.",
            MARGIN,
            y,
            { width: CONTENT_W, align: "right" },
          );
        y += 28;

        // ── ITEMS TABLE ───────────────────────────────────────────────────────
        const COL_W = [36, 105, CONTENT_W - 36 - 105 - 64 - 58, 64, 58];
        const COL_LABELS = ["#", "رقم القطعة", "الوصف", "الكمية", "الوحدة"];
        const ROW_H = 22;

        // Header row
        doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(BLUE);
        let cx = MARGIN;
        COL_LABELS.forEach((label, i) => {
          doc.font("Amiri").fontSize(10).fillColor("#ffffff")
            .text(label, cx, y + 5, {
              width: COL_W[i],
              align: "center",
              lineBreak: false,
            });
          cx += COL_W[i];
        });
        y += ROW_H;

        // Data rows
        opts.items.forEach((item, idx) => {
          const rowBg = idx % 2 === 0 ? "#ffffff" : "#f4f7fa";
          doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(rowBg).stroke("#d8e0e8");

          const cells = [
            String(idx + 1),
            item.partNo ?? "—",
            item.description,
            item.qty ?? "—",
            item.uom ?? "—",
          ];

          cx = MARGIN;
          cells.forEach((val, i) => {
            doc.font("Amiri").fontSize(10).fillColor("#333333")
              .text(val, cx + 3, y + 5, {
                width: COL_W[i] - 6,
                align: i === 2 ? "right" : "center",
                lineBreak: false,
              });
            cx += COL_W[i];
          });
          y += ROW_H;
        });

        // ── NOTES ─────────────────────────────────────────────────────────────
        if (opts.notes?.trim()) {
          y += 14;
          const notesH = 44;
          doc.rect(MARGIN, y, CONTENT_W, notesH).fill("#f0f4f8");
          doc.rect(MARGIN + CONTENT_W - 4, y, 4, notesH).fill(BLUE);
          doc.font("Amiri").fontSize(9).fillColor("#888888")
            .text("ملاحظات:", MARGIN + 6, y + 6, {
              width: CONTENT_W - 18,
              align: "right",
              lineBreak: false,
            });
          doc.font("Amiri").fontSize(11).fillColor("#333333")
            .text(opts.notes.trim(), MARGIN + 6, y + 22, {
              width: CONTENT_W - 18,
              align: "right",
              lineBreak: false,
            });
          y += notesH;
        }

        // ── FOOTER ────────────────────────────────────────────────────────────
        const footerY = Math.max(y + 24, doc.page.height - 50);
        doc.rect(MARGIN, footerY, CONTENT_W, 1.5).fill(GOLD);
        const contact = [
          opts.employeeName,
          opts.employeePhone,
          "INFO@CORTOBA-SUPPLIES.COM",
        ]
          .filter(Boolean)
          .join("   |   ");
        doc.font("Amiri").fontSize(10).fillColor("#777777")
          .text(contact, MARGIN, footerY + 8, {
            width: CONTENT_W,
            align: "center",
            lineBreak: false,
          });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
  