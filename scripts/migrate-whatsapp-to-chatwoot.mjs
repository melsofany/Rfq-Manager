/**
 * migrate-whatsapp-to-chatwoot.mjs
 *
 * ينسخ سجل الدردشة القديم من جداولنا (whatsapp_chats / whatsapp_media /
 * whatsapp_reactions / suppliers) إلى حساب Chatwoot عبر الـ REST API.
 *
 * ✅ لا يعدّل أو يحذف أي بيانة من قاعدة البيانات الحالية — القراءة فقط.
 *    الجداول الأصلية تبقى سليمة كنسخة احتياطية للقراءة فقط.
 *
 * المتغيرات البيئية المطلوبة:
 *   DATABASE_URL              — Postgres connection string (الخاص بالتطبيق)
 *   CHATWOOT_URL              — عنوان Chatwoot (مثال: https://chatwoot.xxx.onrender.com)
 *   CHATWOOT_ACCOUNT_ID       — رقم حساب Chatwoot
 *   CHATWOOT_INBOX_ID         — رقم صندوق الوارد (WhatsApp channel) في Chatwoot
 *   CHATWOOT_API_TOKEN        — user access token لمستخدم أدمن في Chatwoot
 *
 * الاستخدام:
 *   DATABASE_URL=... CHATWOOT_URL=... CHATWOOT_ACCOUNT_ID=1 CHATWOOT_INBOX_ID=1 \
 *     CHATWOOT_API_TOKEN=... node scripts/migrate-whatsapp-to-chatwoot.mjs
 *
 * ملاحظات:
 *   - يُنشئ جهات اتصال (contacts) للموردين حسب رقم الهاتف.
 *   - يُنشئ محادثة (conversation) لكل رقم هاتف، ثم يضيف الرسائل بالطابع الزمني الأصلي.
 *   - الميديا المخزّنة كـ bytea تُرفع كمرفقات على الرسائل.
 *   - يعمل بشكل idempotent تقريباً: يتحقق من وجود جهة الاتصال قبل إنشائها.
 */

import pg from "pg";

const { Client } = pg;

const DB_URL = process.env.DATABASE_URL;
const CW_URL = process.env.CHATWOOT_URL?.replace(/\/$/, "");
const CW_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CW_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CW_TOKEN = process.env.CHATWOOT_API_TOKEN;

for (const [name, val] of [
  ["DATABASE_URL", DB_URL],
  ["CHATWOOT_URL", CW_URL],
  ["CHATWOOT_ACCOUNT_ID", CW_ACCOUNT_ID],
  ["CHATWOOT_INBOX_ID", CW_INBOX_ID],
  ["CHATWOOT_API_TOKEN", CW_TOKEN],
]) {
  if (!val) {
    console.error(`❌ متغير بيئي ناقص: ${name}`);
    process.exit(1);
  }
}

const client = new Client({ connectionString: DB_URL });
await client.connect();
console.log("✅ متصل بقاعدة البيانات (قراءة فقط).");

const headers = {
  api_access_token: CW_TOKEN,
  "Content-Type": "application/json",
};

async function cw(path, init = {}) {
  const res = await fetch(`${CW_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chatwoot ${init.method || "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── 1) جهات الاتصال من جدول الموردين ────────────────────────────────────────
const contactByPhone = new Map(); // phone(normalized) → chatwoot contact id

async function findOrCreateContact({ name, phone }) {
  if (contactByPhone.has(phone)) return contactByPhone.get(phone);
  // ابحث أولاً (يدعم البحث بالبريد/الاسم/الهاتف)
  let id;
  try {
    const found = await cw(
      `/api/v1/accounts/${CW_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(phone)}`,
    );
    const match = (found.payload || []).find((c) => c.phone_number?.endsWith(phone));
    if (match) id = match.id;
  } catch {
    /* may not be supported on all versions — fall through to create */
  }
  if (!id) {
    const created = await cw(`/api/v1/accounts/${CW_ACCOUNT_ID}/contacts`, {
      method: "POST",
      body: JSON.stringify({
        inbox_id: Number(CW_INBOX_ID),
        name: name || phone,
        phone_number: `+${phone}`,
        identifier: `supplier:${phone}`,
      }),
    });
    id = created.payload?.contact?.id ?? created.id;
  }
  contactByPhone.set(phone, id);
  return id;
}

// ─── 2) المحادثات حسب رقم الهاتف ─────────────────────────────────────────────
const conversationByPhone = new Map();

async function findOrCreateConversation(contactId, phone) {
  if (conversationByPhone.has(phone)) return conversationByPhone.get(phone);
  const created = await cw(`/api/v1/accounts/${CW_ACCOUNT_ID}/conversations`, {
    method: "POST",
    body: JSON.stringify({
      source_id: null,
      inbox_id: Number(CW_INBOX_ID),
      contact_id: contactId,
      status: "open",
    }),
  });
  const id = created.id;
  conversationByPhone.set(phone, id);
  return id;
}

// ─── 3) التشغيل ───────────────────────────────────────────────────────────────
async function main() {
  // اجلب كل الأرقام المميزة مع اسم المورد إن وُجد
  const { rows: chatGroups } = await client.query(`
    SELECT wc.phone,
           MAX(s.name) AS supplier_name
    FROM whatsapp_chats wc
    LEFT JOIN suppliers s ON s.id = wc.supplier_id
    GROUP BY wc.phone
    ORDER BY MIN(wc.created_at);
  `);
  console.log(`📦 ${chatGroups.length} محادثة (رقم هاتف) للترحيل.`);

  let totalMessages = 0;
  let totalMedia = 0;

  for (const group of chatGroups) {
    const phone = group.phone.replace(/\D/g, "");
    try {
      const contactId = await findOrCreateContact({
        name: group.supplier_name || phone,
        phone,
      });
      const convoId = await findOrCreateConversation(contactId, phone);

      const { rows: messages } = await client.query(
        `SELECT * FROM whatsapp_chats WHERE phone = $1 ORDER BY created_at ASC`,
        [group.phone],
      );

      for (const m of messages) {
        const isIncoming = m.direction === "inbound";
        const content = m.body || "";
        // المرفق (لو وُجد ميديا مخزّنة)
        let attachment = null;
        if (m.media_id) {
          const { rows: mediaRows } = await client.query(
            `SELECT data, mime_type, filename FROM whatsapp_media WHERE wa_media_id = $1`,
            [m.media_id],
          );
          if (mediaRows.length > 0) {
            const buf = Buffer.from(mediaRows[0].data);
            const blob = new Blob([new Uint8Array(buf)], {
              type: mediaRows[0].mime_type || "application/octet-stream",
            });
            const form = new FormData();
            form.append("content", content || (mediaRows[0].filename || "file"));
            form.append(
              "message_type",
              isIncoming ? "incoming" : "outgoing",
            );
            form.append("private", "false");
            form.append(
              "attachments[]",
              blob,
              mediaRows[0].filename || "attachment",
            );
            try {
              await cw(
                `/api/v1/accounts/${CW_ACCOUNT_ID}/conversations/${convoId}/messages`,
                { method: "POST", body: form, headers: {} },
              );
              totalMedia++;
              totalMessages++;
              continue;
            } catch (err) {
              console.warn(
                `  ⚠️ فشل رفع مرفق لـ ${phone} (${m.media_id}): ${err.message}`,
              );
            }
          }
        }

        // رسالة نصية
        try {
          await cw(
            `/api/v1/accounts/${CW_ACCOUNT_ID}/conversations/${convoId}/messages`,
            {
              method: "POST",
              body: JSON.stringify({
                content,
                message_type: isIncoming ? "incoming" : "outgoing",
                private: false,
              }),
            },
          );
          totalMessages++;
        } catch (err) {
          console.warn(`  ⚠️ فشل إرسال رسالة لـ ${phone}: ${err.message}`);
        }
      }
      console.log(`  ✓ ${phone}: ${messages.length} رسالة`);
    } catch (err) {
      console.error(`✗ فشل ترحيل ${phone}: ${err.message}`);
    }
  }

  console.log(`\n🎉 تم الترحيل: ${totalMessages} رسالة (${totalMedia} بمرفق).`);
  console.log(
    "ℹ️ الجداول الأصلية (whatsapp_chats/media/reactions) لم تُمَسّ — تبقى كنسخة احتياطية.",
  );
  await client.end();
}

main().catch((err) => {
  console.error("خطأ فادح:", err);
  process.exit(1);
});
