# دمج Chatwoot كبديل لصفحة الدردشة `/whatsapp`

يستبدل هذا الدمج صفحة الدردشة المبنية يدوياً (`/whatsapp`) بواجهة **Chatwoot**
الجاهزة والقوية، مع الحفاظ على كل البيانات التاريخية (لا تُحذف أي بيانة).

صفحة `/whatsapp` أصبحت تعرض **Chatwoot داخل iframe** مع تسجيل دخول تلقائي (SSO)
للمستخدم الحالي. الصفحة القديمة بقيت متاحة للقراءة فقط على `/whatsapp-legacy`.

---

## 1) المكوّنات المُضافة في هذا المشروع

| الملف | الدور |
|------|-------|
| `artifacts/api-server/src/modules/chatwoot/index.ts` | جسر SSO: `GET /api/chatwoot/sso` و `GET /api/chatwoot/status` |
| `artifacts/rfq-portal/src/modules/communications/pages/chatwoot.tsx` | مكوّن iframe الذي يعرض Chatwoot عند `/whatsapp` |
| `scripts/migrate-whatsapp-to-chatwoot.mjs` | سكربت ترحيل البيانات (قراءة فقط من DB → Chatwoot API) |

جداول الـ WhatsApp القديمة (`whatsapp_chats` / `whatsapp_media` / `whatsapp_reactions`)
+ مسارات `/api/whatsapp/*` **لم تُحذف ولم تُعدَّل** — تبقى كنسخة احتياطية.

---

## 2) المتغيرات البيئية المطلوبة (على خدمة التطبيق في Render)

```
CHATWOOT_URL=https://chatwoot.xxx.onrender.com   # عنوان خدمة Chatwoot
CHATWOOT_ACCOUNT_ID=1                            # رقم الحساب في Chatwoot
CHATWOOT_PLATFORM_TOKEN=...                      # Platform App access token (super-admin)
CHATWOOT_INBOX_ID=1                              # (اختياري) رقم صندوق الوارد
```

> عند عدم ضبط هذه المتغيرات، تعرض صفحة `/whatsapp` رسالة واضحة بأن Chatwoot
> غير مُعدّ بدلاً من الانهيار.

---

## 3) نشر Chatwoot (خدمة منفصلة)

Chatwoot تطبيق Rails+Vue يحتاج Postgres + Redis + Sidekiq. أبسط طريقة على Render:

### الخيار أ: عبر Docker image الرسمي (موصى به)

1. أنشئ خدمة **Web Service** جديدة على Render من صورة Docker:
   `chatwoot/chatwoot:latest`
2. أضف متغيرات Chatwoot البيئية (انظر `docker-compose.yml` الرسمي في
   https://github.com/chatwoot/chatwoot) وأهمها:
   ```
   SECRET_KEY_BASE=...          # generate via: rake secret
   RAILS_ENV=production
   REDIS_URL=...                # Redis instance على Render
   POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE=...
   FRONTEND_URL=https://chatwoot.xxx.onrender.com
   DEFAULT_LOCALE=ar
   ```
3. أنشئ **Redis** instance و **PostgreSQL** instance على Render (أو أعد استخدام
   قاعدة بيانات منفصلة — لا تشارك قاعدة بيانات التطبيق).
4. نفّذ أوامر إعداد قاعدة البيانات مرة واحدة (via Render Shell):
   ```bash
   rake db:chatwoot_prepare db:migrate
   ```
5. أنشئ أول حساب أدمن عبر صفحة `/app` ثم سجّل الدخول.

### الخيار ب: استضافة على خادم خارجي عبر docker-compose

استخدم `docker-compose.yaml` الرسمي من مستودع Chatwoot.

---

## 4) إعداد WhatsApp channel داخل Chatwoot

1. في Chatwoot: **Settings → Inboxes → Add inbox → WhatsApp**.
2. اختر **WhatsApp Cloud API** وأدخل:
   - `Phone Number ID` = نفس قيمة `WHATSAPP_PHONE_NUMBER_ID` الحالية.
   - `Business Account ID` = نفس قيمة `WHATSAPP_BUSINESS_ACCOUNT_ID`.
   - `API Key` (Permanent System User Access Token) = نفس `WHATSAPP_TOKEN`.
3. ستُعطيك Chatwoot **Callback URL** — أضِفها في Meta Developer Portal ضمن
   Webhook subscription للرقم، مع رفع الأحداث `messages` و `message_status`.
4. ⚠️ **أوقف الـ webhook القديم** المؤشّر لتطبيقك الحالي
   (`https://cortoba-rfq.onrender.com/api/webhook/whatsapp`) لتجنّب تكرار
   استقبال الرسائل، إلا لو أردت تشغيل النظامين بالتوازي مؤقتاً.

> ملاحظة: قيود الـ 24 ساعة وقوالب Meta تنطبق على Chatwoot أيضاً لأنها تستخدم
> نفس Official Cloud API — هذه سياسات Meta وليست مشاكل في Chatwoot.

---

## 5) إنشاء Platform App لـ SSO

1. سجّل الدخول لـ Chatwoot كـ **super admin** (المسار `/super_admin`).
2. اذهب لـ `super_admin/platform_apps` → **New platform app**.
3. انسخ **access token** الناتج وضعه في `CHATWOOT_PLATFORM_TOKEN`.
4. امنح الـ Platform App صلاحية على حسابك مرة واحدة عبر Rails console:
   ```ruby
   PlatformAppPermissible.create!(platform_app: PlatformApp.find(1), permissible: Account.find(1))
   ```

بهذا يستطيع التطبيق: إيجاد/إنشاء مستخدم Chatwoot لكل موظف عبر البريد، ثم توليد
رابط SSO لمرة واحدة يفتح داخل الـ iframe دون تسجيل دخول ثانٍ.

---

## 6) ترحيل البيانات التاريخية (بدون فقدان أي بيانات)

> السكربت **يقرأ فقط** من قاعدة البيانات الحالية ولا يعدّلها أبداً.

```bash
DATABASE_URL=<db-التطبيق> \
CHATWOOT_URL=https://chatwoot.xxx.onrender.com \
CHATWOOT_ACCOUNT_ID=1 \
CHATWOOT_INBOX_ID=1 \
CHATWOOT_API_TOKEN=<user-access-token-أدمن-Chatwoot> \
node scripts/migrate-whatsapp-to-chatwoot.mjs
```

السكربت ينشئ:
- **جهات اتصال** (contacts) للموردين حسب رقم الهاتف.
- **محادثة** (conversation) لكل رقم هاتف.
- **رسائل** بالطابع الزمني والمحتوى والاتجاه الأصليين.
- **مرفقات** من الميديا المخزّنة (bytea) على الرسائل.

الجداول الأصلية تبقى سليمة كنسخة احتياطية للقراءة فقط.

---

## 7) ما الذي تغيّر في واجهة المستخدم

- `/whatsapp` → تعرض Chatwoot داخل iframe (الواجهة الجديدة).
- `/whatsapp-legacy` → صفحة الدردشة القديمة (للقراءة/المرجع).
- شريط التنقل الجانبي يبقى كما هو (أيقونة «واتساب» تؤدي إلى `/whatsapp`).
