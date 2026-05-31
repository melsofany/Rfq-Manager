import PDFDocument from "pdfkit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

  export interface OffersPdfOptions {
    rfqNo: string;
    customerRfqNo: string;
    exportDate: string;
    itemAnalysis: Array<{
      rfqItemId: number;
      description: string;
      partNo?: string | null;
      qty?: number | null;
      uom?: string | null;
      referencePrice?: number | null;
      minPrice?: number | null;
      maxPrice?: number | null;
      avgPrice?: number | null;
      offers: Array<{
        supplierName: string;
        price: number;
        taxIncluded: boolean;
        deliveryDays?: number | null;
        deviation: number;
        isLowest: boolean;
        isAnomaly: boolean;
      }>;
    }>;
  }

  const LOGO_BASE64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAABHNCSVQICAgIfAhkiAAAAF96VFh0UmF3IHByb2ZpbGUgdHlwZSBBUFAxAAAImeNKT81LLcpMVigoyk/LzEnlUgADYxMuE0sTS6NEAwMDCwMIMDQwMDYEkkZAtjlUKNEABZgamFmaGZsZmgMxiM8FAEi2FMk61EMyAAANfElEQVRoge1ZeXhV1bX/rX2GOyU3QEIikRmKtJ/0oRBkDigEAgIylEEpAkJ9SGVQhAIiZbBQGeTV0hahfsprQdS+QoHKKDEM+hTRiqiAECQMCZA5dzrn7L3eHzc3Bkwgqfi+932vvz/ud/c6a639+529z9pn7wP8C/8P8PXzk9rkL+p79PvILb6PpDciIXjuUFygoEPhshE/ud256yRgwqbfG2eH9f1VXWLyF2dOEaqgodQYetnFN+pG79aok4BXSjzuhEDJ3ILMznz5wd4LahPjCpet1ZSAUBqILRTM6TPvn6NaPeok4IO921rqLKFJBbcdWnxlQI+SszP/vVtN/rlLhs82ZJAUKGpgDYZWvvBmffCpXFGwd/za2nKqk4DUpg2Egg6AQMwwnbA/6cRHh66MyKh2WvkiV36uiKAxAwCIFTRpm+d+OXZ0df6FezLmh04PknHh4098LwKUtIjAlW0mgCFglJbMvTaw956qvl9umNVMl8EmxAKySi8Mgs86O66q71dHFyUFt/fN8wcvLTUdu4LUOP22CwicixQCClQxJYgFGAAB0O1A38KBfY7FfH25n2fqiqOUmapkYWgkMmOtnLfHdUnN/+tVl5OXwgIAERgEYKNz2wUcGZqRp0gDVxmFb0CALLznWub9hwDAo6yBKnaFACKq9DNkAB+NH9Ai98iUe1LtE0dMm6GEBJjAzJDXCb45au9ZgfzMbsrjOKSqiVQUnefB1OZ/8jW7NkwPl3oBApEAEaBUVBKzg9CPem30pewb54nokMKOzkcARAybkgs9gw4k1oZPnRcyAh2v+Vr011VQNFw2S1sNSDAEmCWUik49BqB0b7mTeC7LHZGQZIOgVY4QM6CgDtaWT50F2C7foeqnEEAMEAhShk4nTnxhQcidcllAVV53BEOAca1+swH+BO0ECwJAYFbgWKUCENbj9lTbwe0QENBdW6WQIEb1MphhuhKCAHCxXnJ6jCQQrUCOy5/d6pnNByPK9HwzgwkQAsQMCYG959ttBoDi81saydPpvUInH5sYPD12aujLp6eUnxnUpmp3tKpD54gmdFNJCQCQpgblKFvXjTOS+HNbE+/D7ds7f9/OT2JBxRldWAoHuopVjOsRgvl+oz0HuwBA8cIeO41wcACDAFLI96e1bDVvXU7ZrowH3JGL+4gEoAQ0hBESLnDcvV+gqdqqO8EZgso9AhJgBoNBpFBELbontXnlcKwvXRGZzArQCMSAbis4JAyWkbYay7aGpQ8TQQsr0rpCmO4dX0h6PpBa7wPvpZxOQplwhADgVJZWMMNM8FeqKmzw45kNLx8dAJZQZsr7reatywEAaYUTAFHx5AcRMFt+FhAZw+q3fr+nCBZvYGEDrIOZwCRBbMAm/4dVyQOAULoW0JhBFfNBESCgQCwAGFBEcAQgGEA4/OBddvC9P16KnIgkJj0Y8pjXQKFvyAMAEexQUXys2XL62lMh3XNOYwdXDf8fK910/W4NCramocBMHx+XubtdSr+nT1MwsgFgkDIrODGIDQCEfKPDqBtHWziavoCJKxekm0EKQAPBXXx1wh2b9+xM3p7dUHpSpiihQ4nogkXMMDS96XWBGq2N6F60XrBlQ6WASF4nS/METqYMT07J3PAaAIQ+z9wQHc3oo8kQYFLQJKHcbDSrWYtnc74lYP7hrBdZmEFUqRY1QeNouXY5jOX9BjwHAElbd/0he8w0Fwn/YSksSCEBy46rGufoyXsBOnZdLrNxJ/fAD+Pad3r2KgBcOz4h3RDqMYJdcScZTBK6NBE2/a/Va/nqquo4CQAoT6zXn8BQtVzXbCFgFJUtQkXpe+jRUVb9v+/rHohPXcwkINjB10MeaRvzT12w5R9BT8q2WPvMvolNzvvb/BgVtf/sFxObJpj5WYADJhck4qGEF4J1lGr1X/f84M3xNXERALDw7b8dVJ64Pwt161EAEB1iJbG8Z58NVe1N3tqxsKxe40G6BCxXUZ+q1woSu6yL/W/V55XcH/b4bR4AnP5yy70pBi8JiaYjvwotc61ss10Ybd4Szg+2iq8aL3cn3LV5zM25VMHKLun5wraSAaphqfp2tHVHYru527d/VtWcM3JgZlxp2XMNd2V3qU2a74LrFrIXE/2tiQiqdvTBDOj5RYdutLd4Y+fbZQ1TXlne517PbeJZI64TcHHH9rJgyxatQRRlV4tnwnCchOU9eu+80d7yP99cn/joI+HbR7V6VMtw9RNPtlMffvQp1VIEA3DifQt/cWDv4tvM75aokd2cwYNTk/ILLwipCBqBlKYo+hLNDpgIgoTjgAVALKFA0JNSJszY/bdX//fo3+L2DtqxURtSpGjST8dXuztaNn5CEl3Iay/DTmfTifQVyu5pJiRNf3Lv9t98P3S/jVoV/qX9+ncwSyMz9Qb1fvnUzr9+tbpXv1lkyUYzj+x7+kbfFZ37jbRap5ya/6eNnwDAkm7px/WQdTcAWA3inlm4b+/KuhB8qmevCYYj0zsOG/z4T2Y9E5nZtdsflOk98R9Ze1+qtYAXOvdgMyIRdNNJkZr6iHHuwlEACHp9cxcc3Lf8ZrEremVs4pKyMYqBstSkjs//fftHtSX/5NiHG8cdP5WrAHBc3PpAMHzBZGuRkAJ5Dbyd/vxu9oe12g8oQ1wEKXg119mI13eaBUVf4XXj5K1irUCkoQQBGqEu5AGA/P4rUkT3cZLwqe7z5igmOIaA1+U7X5dcWHH/oAdi/5f1f6jxrzOH3l2buKUdO/PSjmm8pHP6F3XqsALTRoxqOLvvgPRY+6mMwd1/PnBQk1j7llNo3aBRzUPXroyzHasZsTKF21sudTru9njNwjjf+oVvbg4AwKohQ2c5rHRZGjo2L2tP5ZZw6cix7TW7CLhSmGRJkcxKKNOn5849cCAr5jO9fVpCnFL9HUEWE2lOgu/M6qysjwHgub6D218tzR/hUvxvLKkEpnlszXvZq2N76JsKeD5jwHR3YdEamxy4XP6TGvCxtK3hUkYMUjrco4d4ps6eE37moaEt7jiXd1aSBHvjX55zeP/jS7ul/0xYah3LCBgSbMZB0zTHCQV1Zglbp4B/cGby7AWLgrP6D8kQBXm7NUdBKQWR4J+2LPvAS9O79vyLVl42DGSCk+IXRkLhh6is/B7l8uKHQ4e7p81/OlLjM7Bk6PC23oLSNcwKZkLKxpmH9reddmj/GDKMMANwXFrh1NlzwgDQoCjU1REOiDSUE+8DgPz4uMOWR98iFEEpAatZ07R5h98xfHfdNdoGAEm+0h3vzACAlbu27SG261mHFWww/I2b7JjSudtUDpQPk9DgtG3V68X9+xZ7mjYfbBNB2mF8uu2tucBNNvVa/tVf2cKCYIE7enWZBgBrli5NcMKheAJBQXwQ841wpBuDIFkBTRq/BwAv7dp5gmznTgcEaDoWv77xYwCwI+XXFADFCo7bVdkfS/RTCpCGjrmbNuaYEfsFFgC5XaW/2bLpXQBQHAEzQbGCUNTkpgK8TEMJEnp8/OWHn51fAgD0wWedAQlNKcDnqzy7McKh3goAmy4s2bzxQswuLNXVIQXh9VwlIgkA5UVlXQmInsC5zMqqZEciXQEAJM4+O+XxFCUtr5ICyuPeEfNxyoMtFaJHMJquXalRwC/Gj28irTCIdVgavRuzh4pLujELKCVQqMtKAUxGW4aATfIfMducseOSbGULYobUqPKN1bas7ooZTIBKangIAOY8Oq4+S0uTxNCEkRU6e7GnhABYwTGqxJYHO0kCFBMCbvFJjQISTl9qBZLRPa5mnqq807rsSYphCYGWI0f8NwCsGj2mNWwbDEAIvVKs62Jud8HRsyDhjj8Ss2vEncEK7HYFVm16LQAAxSdz0sEVBxTxnuzA1aK2BEAxwDp9XikgbA1gBmyh0Lx32vYaBZR7XaWa0iBYwoFTWanCxWXNHNLAhiGnTJxsAUDJ5au9wAxmRsBtvhfzjdjclQFIxeD6vncAYOeB3YYMBv0OEaSD7JivqWQnBUBJIOR1Z8OgaxIMCcDjTygDAGYmJxLprRSDdSNr8cKVQeAmZXTFfT2LNdtKsN1G2PB6J8cHQoVFHtdaWVjaHLoCmZ55WmnghOPzTnMi1gPMjEhy/SFlZUW5LinChu56SwSDPwIByfe262fZdnlZWSAtkPP1GpsI0PSdyXe3fWz+a6/mz+je46BdEuiuNAEtuX5apCR4pwwFt5ICREOEuuNOQvPLcy+/7pSV3qcMF3vv6+Rf//Lvy28qoOfose7+X+e+bNp2ps1OEhNBJyNXGnRWOtyGbNlICYCVshSRzcxgwAcAihggUhJwAIYtlckAmAgQJBUrycymHR8/6nfZWW9M7ZAm2baFEoAjtOhhFtiKDZAtGUzIc9zGX/pOnjTjsUmTK9+O63y8fruxfPyk1JxjRy+CFJQvYf36Iwd/Vpf4Wn3GqQkPnz5PLcaNyiVWd9qpzVr/+r/eOFPXHOdyTj7BxGClw25Yr06fcIHv+KE7cfK4B90BdSdCAmZJ8eN1jb+/70AvykPzlWJwcsP5r27bfq6uOb6TgJc69tsR8rousItwSTm1/jQaQ8s4nxYBCux69X+6Yf/uOt/9f+H/Av4HNR8m1l+J+FIAAAAASUVORK5CYII=";

  function getLogoBuffer(): Buffer {
    const base64 = LOGO_BASE64.replace("data:image/png;base64,", "");
    return Buffer.from(base64, "base64");
  }

function getFontPath(): string {
  // build.mjs banner sets globalThis.__dirname to the bundle directory.
  // Use it for reliable asset resolution inside an esbuild ESM bundle.
  const g = globalThis as Record<string, unknown>;
  const baseDir: string =
    typeof g.__dirname === "string"
      ? (g.__dirname as string)
      : dirname(fileURLToPath(import.meta.url));
  const fontPath = resolve(baseDir, "assets/fonts/Amiri-Regular.ttf");
  if (!existsSync(fontPath)) {
    throw new Error(
      `Amiri font missing at: ${fontPath} (baseDir=${baseDir})`
    );
  }
  return fontPath;
}

  function fmt(n: number): string {
    return n.toLocaleString("en-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  export function generateOffersPdf(opts: OffersPdfOptions): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      // Safety timeout: if PDFKit never emits "end", reject after 25s
      const pdfTimeout = setTimeout(() => {
        reject(new Error("PDF generation timed out — font file may be missing or PDFKit stream stalled"));
      }, 25000);

      try {
        const fontPath = getFontPath();
        const doc = new PDFDocument({
          size: "A4",
          layout: "landscape",
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          autoFirstPage: true,
          compress: false,
        });

        const chunks: Buffer[] = [];
        let settled = false;
        const settle = (fn: () => void) => {
          if (!settled) { settled = true; fn(); }
        };
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => {
          clearTimeout(pdfTimeout);
          settle(() => resolvePromise(Buffer.concat(chunks)));
        });
        doc.on("error", (err: Error) => {
          clearTimeout(pdfTimeout);
          settle(() => reject(err));
        });

        doc.registerFont("Amiri", fontPath);

        const PAGE_W = doc.page.width;
        const PAGE_H = doc.page.height;
        const MARGIN = 28;
        const CONTENT_W = PAGE_W - MARGIN * 2;
        const BLUE = "#1a3a5c";
        const GOLD = "#c8a84b";
        const GREY_BG = "#eef2f7";
        const GREEN = "#166534";

        // ── HEADER ──────────────────────────────────────────────────────────
        doc.rect(0, 0, PAGE_W, 72).fill(BLUE);

        try {
          const logoBuffer = getLogoBuffer();
          doc.image(logoBuffer, PAGE_W - MARGIN - 56, 8, { height: 56 });
        } catch { /* skip */ }

        doc.font("Amiri").fontSize(20).fillColor("#ffffff")
          .text("\u062a\u0642\u0631\u064a\u0631 \u0645\u0642\u0627\u0631\u0646\u0629 \u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u0639\u0631\u0648\u0636", MARGIN, 14, { lineBreak: false });
        doc.font("Amiri").fontSize(9).fillColor(GOLD)
          .text("RFQ PRICE COMPARISON REPORT", MARGIN, 44, { lineBreak: false });

        // ── INFO BAND ──────────────────────────────────────────────────────
        const INFO_Y = 72;
        const INFO_H = 44;
        doc.rect(0, INFO_Y, PAGE_W, INFO_H).fill(GREY_BG);
        doc.rect(0, INFO_Y + INFO_H - 2.5, PAGE_W, 2.5).fill(GOLD);

        const infoCells = [
          { label: "\u0631\u0642\u0645 \u0627\u0644\u0637\u0644\u0628 \u0627\u0644\u062f\u0627\u062e\u0644\u064a", value: opts.rfqNo },
          { label: "\u0631\u0642\u0645 RFQ \u0627\u0644\u0639\u0645\u064a\u0644", value: opts.customerRfqNo },
          { label: "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062a\u0635\u062f\u064a\u0631", value: opts.exportDate },
          { label: "\u0639\u062f\u062f \u0627\u0644\u0623\u0635\u0646\u0627\u0641", value: String(opts.itemAnalysis.length) },
        ];
        const cellW = CONTENT_W / infoCells.length;
        infoCells.forEach((cell, i) => {
          const cx = MARGIN + i * cellW;
          doc.font("Amiri").fontSize(7.5).fillColor("#8899aa")
            .text(cell.label, cx, INFO_Y + 7, { width: cellW, align: "center", lineBreak: false });
          doc.font("Amiri").fontSize(11).fillColor(BLUE)
            .text(cell.value, cx, INFO_Y + 22, { width: cellW, align: "center", lineBreak: false });
        });

        // ── TABLE ──────────────────────────────────────────────────────────
        let y = INFO_Y + INFO_H + 12;
        const ROW_H = 20;

        const allSuppliers = Array.from(
          new Set(opts.itemAnalysis.flatMap((ia) => ia.offers.map((o) => o.supplierName)))
        );

        const fixedW = { num: 26, desc: 180, part: 90, qty: 64, summary: 140 };
        const usedFixed = fixedW.num + fixedW.desc + fixedW.part + fixedW.qty + fixedW.summary;
        const supColW = allSuppliers.length > 0
          ? Math.max(68, Math.floor((CONTENT_W - usedFixed) / allSuppliers.length))
          : 68;
        const totalTableW = usedFixed + supColW * allSuppliers.length;
        const tableX = MARGIN + Math.max(0, (CONTENT_W - totalTableW) / 2);

        const drawTableHeader = (hy: number) => {
          doc.rect(tableX, hy, totalTableW, ROW_H).fill(BLUE);
          const headers = [
            { label: "#", w: fixedW.num },
            { label: "\u0627\u0644\u0648\u0635\u0641", w: fixedW.desc },
            { label: "\u0631\u0642\u0645 \u0627\u0644\u0642\u0637\u0639\u0629", w: fixedW.part },
            { label: "\u0627\u0644\u0643\u0645\u064a\u0629", w: fixedW.qty },
            ...allSuppliers.map((s) => ({ label: s, w: supColW })),
            { label: "Min | Avg | Max (EGP)", w: fixedW.summary },
          ];
          let cx = tableX;
          headers.forEach((h) => {
            doc.font("Amiri").fontSize(7.5).fillColor("#ffffff")
              .text(h.label, cx + 2, hy + 5, { width: h.w - 4, align: "center", lineBreak: false });
            cx += h.w;
          });
          return hy + ROW_H;
        };

        y = drawTableHeader(y);

        opts.itemAnalysis.forEach((item, idx) => {
          if (y + ROW_H > PAGE_H - 30) {
            doc.addPage({ size: "A4", layout: "landscape", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
            doc.rect(0, 0, PAGE_W, 26).fill(BLUE);
            doc.font("Amiri").fontSize(9).fillColor(GOLD)
              .text("\u062a\u0642\u0631\u064a\u0631 \u0645\u0642\u0627\u0631\u0646\u0629 \u0627\u0644\u0623\u0633\u0639\u0627\u0631 \u2014 " + opts.rfqNo, MARGIN, 8, { lineBreak: false });
            y = 34;
            y = drawTableHeader(y);
          }

          const rowBg = idx % 2 === 0 ? "#ffffff" : "#f4f8fc";
          doc.rect(tableX, y, totalTableW, ROW_H).fill(rowBg).stroke("#d0dbe8");

          const priceBySupplier: Record<string, { price: number; isLowest: boolean; isAnomaly: boolean }> = {};
          for (const o of item.offers) {
            priceBySupplier[o.supplierName] = { price: o.price, isLowest: o.isLowest, isAnomaly: o.isAnomaly };
          }

          const cells: Array<{
            text: string;
            w: number;
            color?: string;
            align?: "left" | "center" | "right";
          }> = [
            { text: String(idx + 1), w: fixedW.num, align: "center" },
            { text: item.description, w: fixedW.desc, align: "right" },
            { text: item.partNo ?? "\u2014", w: fixedW.part, align: "center" },
            { text: item.qty != null ? `${item.qty} ${item.uom ?? ""}`.trim() : "\u2014", w: fixedW.qty, align: "center" },
            ...allSuppliers.map((s) => {
              const p = priceBySupplier[s];
              if (!p) return { text: "\u2014", w: supColW, align: "center" as const };
              return {
                text: fmt(p.price),
                w: supColW,
                align: "center" as const,
                color: p.isLowest ? GREEN : p.isAnomaly ? "#b45309" : "#333333",
              };
            }),
            {
              text:
                item.minPrice != null
                  ? `${fmt(item.minPrice!)} | ${fmt(item.avgPrice!)} | ${fmt(item.maxPrice!)}`
                  : "\u2014",
              w: fixedW.summary,
              align: "center",
            },
          ];

          let cx = tableX;
          cells.forEach((cell) => {
            doc.font("Amiri")
              .fontSize(8)
              .fillColor(cell.color ?? "#333333")
              .text(cell.text, cx + 2, y + 5, {
                width: cell.w - 4,
                align: cell.align ?? "center",
                lineBreak: false,
              });
            cx += cell.w;
          });
          y += ROW_H;
        });

        // ── FOOTER ──────────────────────────────────────────────────────────
        const footerY = PAGE_H - 22;
        doc.rect(0, footerY - 2, PAGE_W, 24).fill(BLUE);
        doc.font("Amiri").fontSize(8).fillColor(GOLD)
          .text(
            "Cortoba Supplies \u2014 \u0642\u0631\u0637\u0628\u0629 \u0644\u0644\u062a\u0648\u0631\u064a\u062f\u0627\u062a   |   INFO@CORTOBA-SUPPLIES.COM",
            MARGIN,
            footerY + 4,
            { width: CONTENT_W, align: "center", lineBreak: false }
          );

        doc.end();
      } catch (err) {
        clearTimeout(pdfTimeout);
        reject(err);
      }
    });
  }
  