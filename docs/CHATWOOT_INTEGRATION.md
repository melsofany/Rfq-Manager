# Chatwoot — صندوق دردشة الوكلاء على `/whatsapp`

يستبدل هذا الدمج صفحة الدردشة المبنية يدوياً (`/whatsapp`) بواجهة **Chatwoot**
الجاهزة (مفتوحة المصدر، تقييم عالٍ، بلا اشتراك)، مع الحفاظ الكامل على كل
البيانات التاريخية وعلى مسارات إرسال طلبات التسعير وأوامر الشراء.

---

## 1) القاعدة المعمارية الحاكمة (اقرأ هذا أولاً)

> **الـ webhook الخاص بنا يظل هو البوابة الوحيدة إلى Meta.**

`POST /api/webhook/whatsapp` هو ما يشغّل:

- إرسال طلبات التسعير واستقبال ردود التسعير من الموردين،
- إرسال أوامر الشراء وبوت المندوبين (استلام/تسليم)،
- المساعد الذكي (AI assistant).

لذلك **لا يجوز** ضبط قناة WhatsApp داخل Chatwoot ولا تحويل الـ webhook إليه:
ذلك يعطّل كل ما سبق. ولهذا فشل المحاولة الأولى (PR #5 ثم التراجع في PR #6).

Chatwoot هنا **صندوق وارد للوكلاء فقط** (Agent Console)، متصل عبر قناة **API**
لا عبر قناة WhatsApp:

```
المورد ──واتساب──► Meta ──► /api/webhook/whatsapp (بوابتنا)  ──►  قاعدة بياناتنا
                                      │
                                      └── نسخ (mirror) ──► Chatwoot (قراءة الوكلاء)
                                                                     │
الوكيل يردّ في Chatwoot ──► /api/webhook/chatwoot ──► إرسال عبر بوابتنا ──► المورد
```

- **الرسائل الواردة** تُنسخ إلى Chatwoot ليراها الوكلاء.
- **رسائلنا الصادرة** (طلبات التسعير، أوامر الشراء) تُنسخ أيضاً فيرى الوكيل
  السياق كاملاً.
- **ردّ الوكيل** من داخل Chatwoot يُرسل للمورد عبر نفس بوابتنا، ويُسجَّل في
  `whatsapp_chats` — فلا تتفرّق المحادثة بين نظامين.

---

## 2) سلوك آمن افتراضياً (بلا Chatwoot)

بدون ضبط متغيّرات `CHATWOOT_*` تعمل `/whatsapp` **بالصفحة المدمجة الحالية
تماماً كما اليوم** — لا تغيير في السلوك ولا خطر. بمجرد ضبط المتغيّرات تتحول
الصفحة إلى Chatwoot تلقائياً.

لو تعذّر الوصول إلى Chatwoot (خدمة متوقفة) تُعرض رسالة خطأ واضحة مع زر
«فتح صندوق الدردشة المدمج» — لا قفلة أبداً.

---

## 3) المكوّنات

| الملف                                      | الدور                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `modules/chatwoot/client.ts`               | عميل REST (اتصال/محادثة/رسالة)                                     |
| `modules/chatwoot/bridge.ts`               | النسخ (mirror) + جدول الربط `chatwoot_links`                       |
| `modules/chatwoot/index.ts`                | `GET /api/chatwoot/sso` · `/status` · `POST /api/webhook/chatwoot` |
| `rfq-portal/.../pages/chatwoot.tsx`        | واجهة iframe مع SSO + تراجع تلقائي للصفحة المدمجة                  |
| `lib/db/src/schema/chatwoot.ts`            | جدول `chatwoot_links`                                              |
| `scripts/migrate-whatsapp-to-chatwoot.mjs` | ترحيل السجل التاريخي (قراءة فقط من قاعدتنا)                        |

جداولنا (`whatsapp_chats` / `whatsapp_media` / `whatsapp_reactions`) ومسارات
`/api/whatsapp/*` **لم تُحذف ولم تُعدَّل** — تبقى مصدر الحقيقة ونسخة احتياطية.

---

## 4) استضافة Chatwoot — الخيارات والتكلفة

Chatwoot تطبيق **Rails + Sidekiq + Postgres + Redis**، ولا يمكن تشغيله كخدمة
Node على Render بجانب التطبيق. (وهذا سبب تعثّر المحاولة الأولى: Render API لا
يُنشئ خدمة Rails من صورة Docker بسهولة.)

### الخيار أ — Render: خدمة Docker + Redis + قاعدة بيانات منفصلة (مُوصى به)

| المكوّن                  | الخطة الأدنى  | التكلفة التقريبية/شهر |
| ------------------------ | ------------- | --------------------- |
| Chatwoot web (Docker)    | Starter 512MB | ~$7                   |
| Chatwoot worker (Docker) | Starter 512MB | ~$7                   |
| Redis                    | Starter       | ~$3                   |
| PostgreSQL (منفصلة!)     | Basic 256MB   | ~$6                   |
| **الإجمالي**             |               | **~$23/شهر**          |

> ⚠️ **لا تشارك قاعدة بيانات التطبيق** — Chatwoot يحتاج قاعدة خاصة.
> خدمة مجانية (Free 512MB) تنام بعد 15 دقيقة وتُبطئ الردود؛ الأفضل Starter.

الخطوات:

1. أنشئ **PostgreSQL** و **Redis** منفصلين على Render.
2. أنشئ **Web Service** من صورة Docker: `chatwoot/chatwoot:latest` بالأمر
   `bundle exec rails s -b 0.0.0.0`.
3. أنشئ **Background Worker** من نفس الصورة بالأمر
   `bundle exec sidekiq -C config/sidekiq.yml`.
4. اضبط متغيّرات Chatwoot (انظر `deploy/chatwoot/.env.example`)، وأهمها
   `SECRET_KEY_BASE` (من `rake secret`)، `FRONTEND_URL`، `REDIS_URL`،
   وبيانات Postgres المنفصلة.
5. نفّذ مرة واحدة من Render Shell: `bundle exec rails db:chatwoot_prepare`.

### الخيار ب — خادم VPS (أرخص للاستخدام الصغير)

جهاز واحد 2GB RAM (~$6/شهر) عبر `deploy/chatwoot/docker-compose.chatwoot.yml`
الموجود في المستودع. يشغّل كل المكوّنات بأمر واحد:

```bash
cd deploy/chatwoot && cp .env.example .env   # اضبط القيم
docker compose -f docker-compose.chatwoot.yml up -d
```

### الخيار ج — Chatwoot Cloud (مدفوع، بلا إعداد)

مناسب لو أردت البدء فوراً دون تشغيل خدمة؛ لكنه **بمقابل مالي** وليس مجانياً.

---

## 5) ضبط متغيّرات البيئة على خدمة التطبيق (Render)

على خدمة `cortoba-rfq` أضف:

```
CHATWOOT_URL=https://chatwoot.xxx.onrender.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_API_TOKEN=<agent/user access token>
CHATWOOT_INBOX_ID=<رقم قناة الـ API inbox>
CHATWOOT_PLATFORM_TOKEN=<Platform App token — لـ SSO فقط>
CHATWOOT_WEBHOOK_SECRET=<سر عشوائي طويل>
```

- `CHATWOOT_API_TOKEN` يُستخدم للنسخ والردود.
- `CHATWOOT_PLATFORM_TOKEN` لـ SSO (تسجيل دخول تلقائي داخل iframe).
- عند غياب أي منها تبقى الصفحة المدمجة هي المعروضة.

---

## 6) إنشاء قناة **API** داخل Chatwoot (وليس WhatsApp)

1. **Settings → Inboxes → Add inbox → API**.
2. انسخ رقم القناة إلى `CHATWOOT_INBOX_ID`.
3. **Settings → Integrations → Webhooks** وأضف:
   - الرابط: `https://cortoba-rfq.onrender.com/api/webhook/chatwoot?token=<CHATWOOT_WEBHOOK_SECRET>`
   - الحدث: `message_created`.
4. ⛔ **لا تضبط قناة WhatsApp في Chatwoot، ولا تغيّر webhook في Meta.**
   البوابة تبقى `/api/webhook/whatsapp` كما هي.

> الردّ داخل Chatwoot يمرّ عبر بوابتنا، لذا تخضع الرسائل لسياسات Meta
> (نافذة 24 ساعة/القوالب) تماماً كالسابق — سلوك متوقّع لا خلل.

---

## 7) SSO (تسجيل دخول تلقائي)

1. سجّل الدخول كـ **super admin** (`/super_admin`).
2. `super_admin/platform_apps` → **New platform app** → انسخ التوكن إلى
   `CHATWOOT_PLATFORM_TOKEN`.
3. امنح الصلاحية على الحساب مرة واحدة (Rails console):

   ```ruby
   PlatformAppPermissible.create!(platform_app: PlatformApp.find(1), permissible: Account.find(1))
   ```

---

## 8) ترحيل السجل التاريخي (بلا فقدان بيانات)

> السكربت **يقرأ فقط** من قاعدتنا ولا يعدّلها أو يحذفها.

```bash
DATABASE_URL=<db-التطبيق> \
CHATWOOT_URL=https://chatwoot.xxx.onrender.com \
CHATWOOT_ACCOUNT_ID=1 \
CHATWOOT_INBOX_ID=1 \
CHATWOOT_API_TOKEN=<token> \
node scripts/migrate-whatsapp-to-chatwoot.mjs
```

ينشئ: جهات اتصال، محادثة لكل رقم، وكل الرسائل بطابعها الزمني واتجاهها،
والمرفقات. الجداول الأصلية تبقى سليمة.

بعد الترحيل يعمل ردّ الوكيل على المحادثات القديمة أيضاً: لو لم يوجد صف ربط في
`chatwoot_links` يُقرأ رقم الهاتف من Chatwoot نفسه.

---

## 9) ما الذي يتغيّر في الواجهة

- `/whatsapp` → Chatwoot (مع تراجع تلقائي للصفحة المدمجة إن لم يُضبط).
- `/whatsapp-legacy` → الصفحة المدمجة مباشرةً (مرجع/احتياطي).
- شريط التنقّل كما هو.

---

## 10) فحوصات ما بعد النشر

- `/api/healthz` = 200.
- `/api/chatwoot/status` = 200 (أو 401 غير مسجّل الدخول).
- `/api/webhook/chatwoot?token=wrong` لا يُرسل شيئاً (200 مع تجاهل).
- أرسل رسالة تجريبية من رقم مورد وتأكّد من ظهورها في Chatwoot، ثم ردّ من
  Chatwoot وتأكّد من وصولها للمورد وظهورها في `whatsapp_chats`.
