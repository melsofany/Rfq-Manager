# خطة تنفيذ نظام مسؤوليات المشتريات — Customer Procurement Responsibility System

> **الحالة:** التصميم مُعتمد ومُوثَّق. **نُفِّذ على فرع العمل** (working tree فقط — لا commit/push/deploy). راجع §14 «حالة التنفيذ».
> **النطاق:** قياس «من حقّق البيع» و«إلى أين وصل التوريد» دون فتح القرارات التجارية.
> **خارج النطاق نهائيًا:** توقيع العميل، تأكيد العميل، مستند الاستلام، أي Portal للعميل.
> **المرجع السابق:** `docs/PROCUREMENT_RESPONSIBILITY_SYSTEM.md`.

---

## 0. القرارات المعتمدة (لا تُفتح للنقاش)

### تجارية

1. الإنجاز عند **أول Customer PO** مرتبط بالبند. لا شرط `status='sent'`، لا مرحلة اعتماد.
2. **بند واحد = إنجاز واحد** مهما تعددت الأوامر (`DISTINCT customer_rfq_item_id`).
3. صاحب الإنجاز = **المسؤول عن البند وقت تسجيل أول PO**، لا مُدخِل PO.
4. الإنجاز غير المحسوم **يُقفل ولا يُنسب لاحقًا**.
5. التسليم الجزئي **لا يُسقط** الإنجاز.
6. فصل: صاحب الإنجاز / المسؤول الحالي / مندوب التوريد / من سجّل العملية.
7. تعطيل الموظف والبند بدل الحذف؛ حماية Customer PO من الحذف الذي يفقد الارتباط.

### فنية

| #   | القرار                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `attribution_employee_id` بمرجع `ON DELETE RESTRICT` + `attribution_employee_name` كلقطة؛ تعطيل الموظف هو المسار. التقارير تجمع بالـID وتعرض الاسم من اللقطة.  |
| F2  | تاريخ كامل لفترات الإسناد في `customer_rfq_item_assignments` نفسه؛ قفل صف `customer_rfq_items`؛ `clock_timestamp()` بعد القفل؛ منع التداخل بقيد DB.            |
| F3  | Backup قبل Migration؛ Migration قابلة لإعادة التشغيل؛ **لا حذف بيانات تشغيلية**؛ التراجع بالتعطيل أو Roll-forward.                                             |
| F4  | **الإنجاز يُقفل من أول Customer PO حتى لو ظل `attribution_employee_id = NULL`** (غير محسوم)؛ يُسجَّل `attribution_first_po_at` دائمًا، ولا يُعاد نسبته لاحقًا. |
| F5  | **فصل مفاهيمي:** اكتمال التوريد (`delivery_status='delivered'`) ≠ تأكيد العميل؛ تأكيد/توقيع العميل **خارج النطاق** (لا حقول، لا خطوة، لا Portal).              |

---

## 1. الوضع الحالي (أدلة من الكود)

| المكوّن                | الملف/السطر                                                                                                  | الحقيقة                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| إنشاء Customer PO      | `modules/customer-po/routes.ts:549` (POST)، الرأس `:603`، البنود `:618`                                      | **بلا `db.transaction`**                                                                                                                                |
| ربط بند PO ببند العميل | `lib/db/src/schema/customer_pos.ts:47`                                                                       | `customer_rfq_item_id` → `ON DELETE SET NULL`                                                                                                           |
| حذف بنود طلب العميل    | `modules/customer-rfq/routes.ts:1825`                                                                        | **حذف فعلي**                                                                                                                                            |
| حذف طلب العميل         | `modules/customer-rfq/routes.ts:1885`                                                                        | حذف فعلي                                                                                                                                                |
| جدول الإسناد           | `shared/init-db.ts` (~1457)                                                                                  | **فهرس فريد مطلق** `customer_rfq_item_assignments_item_uq ON (customer_rfq_item_id)` ⇒ صف واحد/بند، بلا فترات                                           |
| حذف الموظف             | `modules/users/auth.ts:288-303`                                                                              | حذف فعلي (admin فقط)                                                                                                                                    |
| مراجع `employees.id`   | `grep` في `lib/db/src/schema/*.ts`                                                                           | معظمها بلا `onDelete` (NO ACTION)؛ `cascade` في `data_entry_sessions`/`employee_categories`؛ `set null` في `ai_assistant`/بعض أعمدة item_categories     |
| **FK إسناد الموظف**    | `item_categories.ts:163` + `init-db.ts` (~1462)                                                              | `customer_rfq_item_assignments.employee_id` → `employees(id) ON DELETE **SET NULL**`؛ `assigned_by` كذلك `SET NULL` ⇒ **حذف الموظف يُفرّغ مرجع الفترة** |
| سجل التسليم            | `shared/init-db.ts:505-517`                                                                                  | لا قيد فريد، لا idempotency                                                                                                                             |
| كتابة `cancelled`      | `modules/customer-po/routes.ts:839`                                                                          | عند إزالة بند من PO: `customerPoId=null, qty/unitPrice/deliveryDate=null, deliveryStatus='cancelled'`                                                   |
| حذف تسليم              | `communications/routes.ts:1297` (حذف صفوف البوت قبل الإدراج) و`customer-po/deliveries.ts:429` (DELETE route) | **حذف فعلي** لسجلات تسليم                                                                                                                               |
| صيغة زر واتساب         | `communications/service.ts:1222-1253`؛ `interactive.d.ts:395`                                                | الحِمْل يُعاد حرفيًا في `button_reply.id`؛ **حد 256**                                                                                                   |
| `context.id`           | `communications/routes.ts:369,1598`                                                                          | مُعرَّف/مقروء، **غير مُثبَت لضغط الأزرار**                                                                                                              |
| امتدادات DB            | `init-db.ts:1351`                                                                                            | `pg_trgm` مستخدم ⇒ الامتدادات ممكنة                                                                                                                     |
| قرّاء الإسناد          | `reports/item-kpis.ts`, `rfq/assignment.ts`, `rfq/assignments.ts`, `rfq/customer-assignment.ts`              | يجب مواءمتهم                                                                                                                                            |

---

## 2. قيد UNIQUE القديم — الاستبدال (النقطة 1)

### 2.1 الاسم والتعريف الفعلي (مُثبَت)

- **الاسم:** `customer_rfq_item_assignments_item_uq` — **فهرس فريد (UNIQUE INDEX)** وليس قيد جدول.
- **التعريف:** `CREATE UNIQUE INDEX customer_rfq_item_assignments_item_uq ON customer_rfq_item_assignments (customer_rfq_item_id);`
- **المصدر:** `shared/init-db.ts` (~1467).
- **الأثر:** يمنع أي صف إسناد ثانٍ لنفس البند ⇒ **يتعارض مباشرة** مع تصميم الفترات.

### 2.2 الاستبدال دون فقد بيانات

```
DROP INDEX IF EXISTS customer_rfq_item_assignments_item_uq;        -- إزالة المطلق (لا يمسّ الصفوف)
CREATE UNIQUE INDEX IF NOT EXISTS customer_rfq_item_assignments_open_uq
  ON customer_rfq_item_assignments (customer_rfq_item_id) WHERE valid_to IS NULL;  -- فترة مفتوحة واحدة
```

- **`DROP INDEX` لا يحذف الصفوف** ⇒ الإسنادات الحالية تبقى. الاستبدال بفهرس أضيق (جزئي).

### 2.3 قيد منع التداخل (فترات مغلقة ومفتوحة)

```
ALTER TABLE customer_rfq_item_assignments
  ADD CONSTRAINT customer_rfq_item_assignments_no_overlap
  EXCLUDE USING gist (
    customer_rfq_item_id WITH =,
    tstzrange(valid_from, COALESCE(valid_to, 'infinity'), '[)') WITH &&
  );
```

- نطاق **نصف مفتوح `[valid_from, valid_to)`** ⇒ لا تداخل، ويُحدَّد المسؤول في أي لحظة.
- `COALESCE(valid_to,'infinity')` ⇒ يمنع تداخل الفترة المفتوحة مع أي فترة تاريخية أيضًا.

### 2.4 إمكانية `btree_gist` (فحص بلا تثبيت)

- `=` على `integer` داخل `gist` يحتاج امتداد **`btree_gist`**.
- **`pg_trgm` موجود** (`init-db.ts:1351`) ⇒ تثبيت الامتدادات مسموح **مبدئيًا**، لكنه **لا يُثبت** توفر `btree_gist` في الصورة/الصلاحيات.
- **فحص قراءة فقط قبل الاعتماد (لا يُنفَّذ الآن):**
  ```sql
  SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('btree_gist');
  SELECT extname FROM pg_extension;
  ```
- **بديل إن رُفض `btree_gist` (متزامن — لا اكتشاف فقط):**

  الفرق المطلوب: **منع** التداخل عند التزامن، لا مجرد **اكتشافه** قبل الحفظ. البديل يعتمد على **قفل صف البند نفسه** في **كل** مسارات تعديل الإسناد:

  ```
  BEGIN TRANSACTION
    1) SELECT ... FROM customer_rfq_items WHERE id = X FOR UPDATE   -- القفل أولًا (serializes all writers)
    2) ref_ts := clock_timestamp()
    3) اغلاق الفترة المفتوحة: UPDATE ... SET valid_to = ref_ts WHERE customer_rfq_item_id=X AND valid_to IS NULL
    4) فحص التداخل للفترة الجديدة [ref_ts, NULL):
       SELECT 1 FROM customer_rfq_item_assignments
        WHERE customer_rfq_item_id = X
          AND tstzrange(valid_from, COALESCE(valid_to,'infinity'), '[)')
           && tstzrange(ref_ts, 'infinity', '[)')
       -- إن وُجد تداخل ⇒ رفض/إعادة المحاولة (لا تُدرج)
    5) INSERT الفترة الجديدة (valid_from=ref_ts, valid_to=NULL)
  COMMIT
  ```
  - **القفل على صف البند** يُسلسِل كل الكتّاب ⇒ لا يمكن لعمليتين متزامنتين اجتياز الفحص معًا.
  - **يجب تطبيقه في كل مسارات الإسناد:** `assignCustomerItemManually` (يدوي)، `ensureCustomerAssignments` (تلقائي)، وأي مسار مستقبلي — وليس مسارًا واحدًا.
  - **جرد كل مسارات الكتابة:** يجب التأكد أنه **لا يوجد مسار مباشر أو Job أو كود قديم** يكتب/يعدّل `customer_rfq_item_assignments` دون هذا القفل. الجرد يشمل: `rfq/customer-assignment.ts`، `rfq/assignment.ts`، `rfq/assignments.ts`، `shared/init-db.ts` (الترحيل)، وأي سكربت. أي مسار يخالف ⇒ يُعدَّل ليأخذ القفل.
  - **بند غير موجود:** إن كان `customer_rfq_item_id` محذوفًا/غير موجود ⇒ **يجب أن يفشل المسار** (لا يستمر دون صف مقفول). `FOR UPDATE` على صف غير موجود يعيد صفر صفوف ⇒ يُعامل كخطأ (404/رفض)، لا متابعة.
  - **الفهرس الجزئي (`WHERE valid_to IS NULL`) ليس بديلًا كاملًا** — يمنع فترتين مفتوحتين فقط، ولا يمنع تداخل الفترات المغلقة؛ منع التداخل الكامل يحتاج `EXCLUDE` **أو** القفل + الفحص أعلاه.
  - **وضوح الضمانة (مهم):** إن تعذّر `btree_gist`، فالحماية **تطبيقية فقط** — تعتمد على التزام **كل** مسارات الكتابة بالقفل. **لا توازي قيد `EXCLUDE`** في مواجهة أي كتابة مباشرة إلى الجدول (SQL يدوي/Job خارج المسارات). القيد وحده هو الضمانة على مستوى قاعدة البيانات.
  - **قرارك إن تعذّر الامتداد.**

### 2.5 حماية تاريخ الإسناد عند حذف الموظف (مُثبَت — تعارض قائم)

- **الوضع الحالي:** `customer_rfq_item_assignments.employee_id` → `employees(id) ON DELETE **SET NULL**` (و`assigned_by` كذلك) — `item_categories.ts:163`، `init-db.ts` (~1462).
- **الخطر:** حذف موظف **ليس له إنجاز مثبت** لكن له فترات إسناد ⇒ **يُفرّغ `employee_id`** ⇒ يُفقد مرجع تاريخ الإسناد (حتى لو كان `attribution_employee_id` محميًّا).
- **الحل (تعديل الـFK):**
  ```
  ALTER TABLE customer_rfq_item_assignments
    DROP CONSTRAINT IF EXISTS customer_rfq_item_assignments_employee_id_fkey;
  ALTER TABLE customer_rfq_item_assignments
    ADD CONSTRAINT customer_rfq_item_assignments_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
  ```
- **التوافق:** `employees` بلا حذف ناعم مستخدم اليوم، ومسار `DELETE /employees/:id` سيُحوَّل إلى **تعطيل** ⇒ `RESTRICT` لا يعيق العمل الطبيعي.
- **قيد `assigned_by`:** يبقى `SET NULL` (ليس هوية المسؤول التاريخي؛ مجرد مُسجِّل الإجراء).
- **`customer_rfq_item_id` → RESTRICT (تصحيح — كان CASCADE):** `ON DELETE CASCADE` يعني أن **أي** حذف فعلي لبند RFQ (من أي مسار) يمحو فترات الإسناد التاريخية ⇒ تعارض مع قرار حماية التاريخ. الحل:
  ```
  ALTER TABLE customer_rfq_item_assignments
    DROP CONSTRAINT IF EXISTS customer_rfq_item_assignments_customer_rfq_item_id_fkey;
  ALTER TABLE customer_rfq_item_assignments
    ADD CONSTRAINT customer_rfq_item_assignments_customer_rfq_item_id_fkey
    FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT;
  ```
  - مسارات حذف بنود Customer RFQ تُحوَّل إلى **تعطيل** (`is_cancelled`)؛ `RESTRICT` يمنع أي تجاوز على مستوى قاعدة البيانات.
  - **مراجعة المسارات:** `customer-rfq/routes.ts:1825` (حذف بنود) و`:1885` (حذف الطلب) + أي حذف مباشر آخر.

### 2.6 نطاق حماية `assigned_by` (النقطة 1 — مُغلقة)

- **الدور المُتحقَّق منه:** `assigned_by` هو **فاعل الإجراء** فقط، ويُنسخ إلى `item_assignment_audit.changedBy` عند التغيير (`customer-assignment.ts:239,257`، `assignment.ts:324`) — ليس هوية المسؤول التاريخي.
- **ليس مفتاح تقارير:** `item-kpis.ts` يجمّع بـ`employeeId` (السطور 88/311/317/477/482/539) — **لا يستخدم `assignedBy` إطلاقًا**.
- **القرار:** `assigned_by` يبقى `SET NULL` — لا يشارك في ملكية المسؤولية، وفقدُه عند حذف الموظف لا يؤثر على KPI أو الملكية.
- **تعطيل الموظف هو المسار الوحيد:** يوجد **مسار حذف واحد فقط** — `DELETE /employees/:id` في `users/auth.ts:288-298` (admin فقط). لا واجهة/عملية أخرى تحذف الموظف. يُحوَّل هذا المسار إلى **تعطيل** (`isActive=false`) ⇒ لا يمكن تجاوز حماية `RESTRICT`.

---

## 3. تحويل الإسنادات الحالية إلى فترات (النقطة 2)

| البند                          | القرار                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| حفظ الإسناد الحالي             | يبقى صفًّا، ويُغلق/يُفتح بفترة.                                                                                                  |
| `valid_from` للإسنادات الحالية | `assigned_at` **إن وُجد** (الحقل موجود: `assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)، وإلا `clock_timestamp()` عند الترحيل. |
| **التمييز الصريح**             | يُوصف كـ**«تاريخ بداية موثق داخل النظام»**، وليس تاريخ بداية المسؤولية الحقيقي.                                                  |
| استخدامها للإنجازات القديمة    | **ممنوع** — لا تُستخدم لنسب إنجاز Customer PO قديم.                                                                              |
| الإنجازات القديمة              | تبقى **غير محسومة** (`attribution_first_po_at IS NULL` + وجود PO).                                                               |

- **Backfill (لا يترك `valid_from` فارغًا أبدًا):** يجب أن تطابق خطوة الـMigration القرار — أي تعيين `valid_from` لكل صف:

  ```sql
  -- 1) املأ من assigned_at المسجَّل فعلًا
  UPDATE customer_rfq_item_assignments
     SET valid_from = COALESCE(assigned_at, clock_timestamp())
   WHERE valid_from IS NULL;
  -- 2) ضمان عدم وجود NULL متبقٍّ
  ALTER TABLE customer_rfq_item_assignments ALTER COLUMN valid_from SET NOT NULL;
  -- 3) الافتراضي للصفوف الجديدة
  ALTER TABLE customer_rfq_item_assignments ALTER COLUMN valid_from SET DEFAULT clock_timestamp();
  ```
  - `COALESCE(assigned_at, clock_timestamp())` يمنع بقاء `valid_from` فارغًا (يطابق القرار). لا يخترع تاريخ مسؤولية حقيقي؛ يستخدم المسجَّل أو وقت الترحيل.

- **FK لـ`voided_by` (هوية من ألغى التسليم — النقطة 5.3):** تُحدَّد السياسة لتتفق مع سجلات التاريخ: `voided_by INTEGER` **بمرجع `ON DELETE RESTRICT`** + لقطة `voided_by_name TEXT` (الاسم وقت الإلغاء). حذف حساب الموظف لا يمحو هوية منفذ الإلغاء.

---

## 4. Idempotency — دورة الحياة الكاملة (النقطة 3)

### 4.1 WhatsApp (رمز لكل سؤال)

- `sendRepConfirm` (service.ts:1222) يولّد `crypto.randomUUID()` لكل سؤال.
- الحِمْل في `Button(..., id)`: `work_order_confirm_delivery:<no>:<itemId>:delivered:<token>` (≈90 حرفًا < 256).
- عند الضغط يعود الرمز ⇒ **هو نفسه قيمة `idempotency_key`** (مع `customer_po_item_id`)، ويدخل مباشرةً في **القيد الفريد في قاعدة البيانات** `(customer_po_item_id, idempotency_key)` — **ليس فحصًا في الكود فقط**.
- **النتائج الثلاث المطلوبة:**
  - **إعادة إرسال نفس الـWebhook** ⇒ `msg.id` (طبقة ثانية) + القيد ⇒ **لا عملية ثانية**.
  - **الضغط مرتين على نفس السؤال** ⇒ **نفس الرمز** ⇒ نفس `idempotency_key` ⇒ **القيد يمنع** تسليمًا ثانيًا.
  - **سؤال جديد لتسليم جزئي جديد** ⇒ **رمز جديد** ⇒ `idempotency_key` جديد ⇒ **يُقبل كعملية مستقلة**.
- **ضغطتان متزامنتان** ⇒ **القيد الفريد في DB** هو الحماية النهائية (لا فحص برمجي وحده).
- **`msg.id` طبقة ثانية في عمود مستقل (لا في `idempotency_key`):** يُخزَّن معرّف الرسالة (`messages[].id`) في عمود `wa_message_id` منفصل، ويُلتقط **صراحةً** من الـWebhook — لا يُفترض ضمنيًّا. الغرض منه منع إعادة معالجة **نفس** الـWebhook عند إعادة إرسال Meta. ملاحظة: `context.id` **غير مُثبَت** لضغط الأزرار (المقطع 1)، فيُعتمد `msg.id` من الرسالة الواردة نفسها.
- **الطبقتان معًا:** الرمز الثابت لكل سؤال (قيمة `idempotency_key` ⇒ يمنع تكرار نفس السؤال عند الضغط مرتين) + `wa_message_id` (يمنع إعادة معالجة الـWebhook نفسه).

### 4.2 صفحة التسليمات (UUID لكل عملية إرسال)

| السؤال                                  | القرار                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| المفتاح لكل بند أم لكل عملية؟           | **لكل عملية إرسال** (وليس ثابتًا لكل بند). لطلبات متعددة البنود: مفتاح لكل بند داخل الطلب.                                                                                                                           |
| التخزين                                 | `localStorage['delivery-draft:<customerPoId>:<customerPoItemId>']`                                                                                                                                                   |
| Refresh/فشل/نتيجة غير محسومة            | المفتاح يبقى.                                                                                                                                                                                                        |
| **نجاح الخادم + توقف الصفحة قبل المسح** | إعادة الإرسال بنفس المفتاح ⇒ الخادم **يعيد نتيجة العملية السابقة** (`ON CONFLICT ... DO NOTHING` ثم إرجاع الصف الموجود) ⇒ **لا تسليم ثانٍ**. الواجهة ترى النجاح ⇒ تنشئ **مفتاحًا جديدًا** لأي تسليم جزئي مستقل لاحق. |
| إعادة استخدام المفتاح ببيانات مختلفة    | **يُرفض** (`409`) — لا تُسجَّل عملية جديدة بصمت؛ يُقارَن محتوى الطلب (الكمية/الرفض) بالصف المحفوظ.                                                                                                                   |
| حماية التزامن                           | **قيد فريد في DB** (وليس فحصًا برمجيًا).                                                                                                                                                                             |

- **الفرق الجوهري:** وجود UUID في المتصفح **لا** يمنع تسليمًا جديدًا؛ **نتيجة الخادم هي المرجع**.

### 4.3 الطلبات متعددة البنود — الذرية والمقارنة (النقطة 3 — مُغلقة)

**حسم الذرية (سؤال صريح):** المطلوب **ذرية الطلب بالكامل** — معاملة واحدة لكل الطلب (كل البنود تنجح أو لا شيء). هذا يلغي حالة «نجح بند وفشل آخر» داخل الطلب الواحد.

- **العلاقة:** الطلب يحمل `operationKey` واحدًا؛ لكل بند مفتاحه `idempotency_key = "<operationKey>:<customerPoItemId>"`. القيد الفريد على `(customer_po_item_id, idempotency_key)`.
- **الوضع الحالي (مُثبَت):** `POST /customer-po/:id/deliveries` يعالج البنود **حلقيًّا بلا Transaction** (`deliveries.ts:185-248`) ⇒ نجاح جزئي ممكن. **يُستبدل** بمعاملة واحدة.

**آلية إعادة الإرسال (لا تعتمد على `ON CONFLICT` وحده) — التخزين المطلوب (تصحيح يُغلق ثغرة اكتشاف مجموعة البنود):**

- **يُضاف `operation_key TEXT` كحقل مستقل** على `customer_po_item_deliveries` (بالإضافة إلى `idempotency_key`)، مع **فهرس** `(operation_key)`، و**`payload_hash TEXT`** لبصمة محتوى الطلب الكامل. هذا الحقل موجود صراحةً في المخطط النهائي (المقطع 8) وخطوات Migration (7.1/11).
- **قيد UNIQUE لمنع التكرار المتزامن (إلزامي):** يجب أن يكون هناك **قيد فريد على مستوى قاعدة البيانات** يعمل كحماية نهائية:
  - **الخيار (أ) — صفوف مسطّحة:** `CREATE UNIQUE INDEX ... ON customer_po_item_deliveries (operation_key, customer_po_item_id);` ⇒ يمنع تكرار بند داخل العملية، ويجعل الطلبين المتزامنين بنفس المفتاح يتصادمان على القيد (الثاني ينتظر ثم يقرأ/يقارن).
  - **الخيار (ب) — جدول عمليات:** `operation_key TEXT UNIQUE` في جدول العمليات (يرتبط به كل بند). الأبسط والأدقّ لضمان عملية واحدة لكل مفتاح.
  - **ملاحظة مهمة:** **لا يجوز** `UNIQUE (operation_key)` وحده على جدول البنود المسطّح — العملية تحتوي **عدة** بنود، فيجب أن يكون القيد `(operation_key, customer_po_item_id)`.
- **ثابت التصميم (لا يُخترق):** `operation_key` محفوظ **في كل صف** من صفوف العملية (أو في **جدول عمليات مستقل** يرتبط به كل بند). الاسترجاع يكون **بـ`operation_key`** ⇒ **مجموعة البنود الأصلية كاملة**، **لا** بالبحث عن البنود الموجودة في الطلب المعاد إرساله فقط. هذا هو الفرق الذي يمنع **اختفاء بند محذوف** دون اكتشافه.
- **حقول المقارنة إلزامية:** عدد البنود + **هويات البنود** (`customerPoItemId`) + **الكميات** (`delivered_qty`) + **بيانات الرفض** (`rejected_by_customer_qty`, `rejection_reason`) — كلها تُقارن، ويُدعم ذلك بـ`payload_hash`.
- **تعريف `payload_hash` (إلزامي):** يُحسب من **مجموعة البنود كاملة مرتبة تصاعديًا بـ`customerPoItemId`**، بحيث يدخل فيه لكل بند: `customerPoItemId` + `delivered_qty` + `rejected_by_customer_qty` + `rejection_reason`. أي حذف/إضافة بند أو تغيير كمية/رفض ⇒ يتغيّر الهاش ⇒ **409**.

```
1) SELECT * FROM customer_po_item_deliveries WHERE operation_key = :opKey
2) إن لم توجد صفوف ⇒ أدرج كل بنود الطلب (داخل المعاملة) مع operation_key + idempotency_key
3) إن وُجدت ⇒ قارن على مستوى الطلب الكامل:
   - مجموعة هويات البنود المحفوظة (customerPoItemId) == مجموعة هويات الطلب الجديد
   - لكل بند: طابق المحتوى (delivered_qty, rejected_by_customer_qty, rejection_reason)
   - تطابق كامل ⇒ أعد النتائج الأصلية لكل بند — لا إدراج
   - أي اختلاف (بند محذوف/مضاف/محتوى مختلف) ⇒ 409 (لا تسجيل بصمت)
```

- **المثال الحاسم:** الطلب الأصلي (OP-123) = A,B,C محفوظة. طلب جديد بنفس المفتاح = A,B فقط ⇒ البحث بـ`operation_key` يسترجع **A,B,C** ⇒ المجموعات مختلفة ⇒ **409**. (البحث بالمفاتيح المشتقة فقط كان سيجد A,B ويعتبرهما متطابقين — **الثغرة المُغلقة**.)
- **بديل مكافئ (مذكور للاكتمال):** جدول عملية يحمل `operationKey` + `payload_hash` لبصمة الطلب الكامل؛ يُختار أيهما أنسب عند التنفيذ — كلاهما يضمن استرجاع العملية الأصلية كاملة.
- **النتيجة المعادة للبند الناجح** = نتيجة عمليته الأصلية (من الصفوف المحفوظة)، لا تجاهل تكرار.

**التعارض المتزامن (طلبَان بنفس المفتاح في آنٍ واحد):**

- الطلب الأول يُدرج؛ الثاني ينتظر على **القيد الفريد** حتى ينتهي الأول (لا يُعاد إدخال أي بند).
- بعد انتهاء الأول، الثاني **يقرأ الصفوف المحفوظة، يقارن الطلب الكامل، ثم يعيد النتيجة الأصلية أو 409** — لا:
  - رد نجاح فارغ،
  - إعادة إدخال بعض البنود،
  - إرجاع نتيجة لا تمثل العملية الأصلية،
  - اعتبار طلب مطابق طلبًا جديدًا.

- **الحماية النهائية:** القيد الفريد في DB يمنع سجلين متزامنين (سباق)؛ والمقارنة تُعاد قراءتها من الصفوف بعد انتهاء المتعارض.
- **سيناريو «نجح بندَان»:** مع الذرية الكاملة لا يحدث نجاح جزئي داخل الطلب؛ ولو وُجد صف من طلب سابق (نفس المفتاح) فهو يُقارَن ويُعاد، لا يُكرَّر.

> **ملاحظة تصميمية:** الذرية الكاملة تعني أن فشل بند واحد يُلغي الطلب كله (لا حفظ جزئي) — هذا هو القرار الصريح، وليس نجاحًا مستقلًا لكل بند.

---

## 5. الإلغاء — فصل الحالات (النقطة 4)

> **حارس نطاق (لا يُفتح):** **لا** تُضاف حقول تأكيد العميل (`customer_confirmed*`) ولا خطوة تأكيد في البوت/الصفحة ولا مستند استلام ولا Portal. اكتمال التوريد مفهوم منفصل عن تأكيد العميل — يُعرض الفرق في التقارير فقط، دون تنفيذ أي وظيفة تأكيد.

| الحالة                 | المصدر/الحقل                                                                                     | السلوك                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| إلغاء بند Customer RFQ | `customer_rfq_items.is_cancelled` (جديد)                                                         | تعطيل؛ لا يمحو الإنجاز/الفترات.                   |
| إلغاء بند Customer PO  | `customer-po/routes.ts:839` — يُفصَل البند `customerPoId=null` + `deliveryStatus='cancelled'`    | يبقى كما هو؛ **لا يُساء استخدامه لحالة التوريد**. |
| رفض التوريد            | `customer_po_item_deliveries.deliveryStatus='rejected'`                                          | طرفي، ليس إنجازًا.                                |
| إلغاء سجل تسليم مسجَّل | `DELETE /customer-po/deliveries/:deliveryId` (`deliveries.ts:429`) — **حاليًا يحذف الصف فعليًا** | يُستبدل بإلغاء ناعم (أدناه).                      |

**التصميم المتوافق:**

- `customer_po_items.delivery_status` قيمه المعلنة `pending|partial|delivered|rejected`. القيمة `cancelled` تُكتب **لإشارة إلغاء بند PO** (مصدر منفصل).
- **التقارير تفصل المصادر:** لا تعتبر `delivery_status='cancelled'` حالة توريد عادية، ولا تستخدمها لنسب الإنجاز.
- **إلغاء سجل تسليم سابق (النقطة 4 — مُغلقة):**
  - **لا حذف للصف الأصلي** — يُضاف عمود `voided BOOLEAN NOT NULL DEFAULT false` (+ `voided_at`, `voided_by`, `void_reason`) على `customer_po_item_deliveries`.
  - **إلغاء حدث مستقل:** `PATCH /customer-po/deliveries/:deliveryId/void` يضبط `voided=true` (بدل `DELETE`).
  - **تأثير الكميات:** `recomputeItemTotals` + `recordItemDelivery` **يستبعدان الصفوف `voided=true`** ⇒ الكمية الملغاة **لا تُحتسب** في المجاميع أو `delivery_status`.
  - **تاريخ العملية الأصلي لا يتغيّر:** `delivered_at` يبقى كما هو؛ الإلغاء يُسجَّل في `voided_at` (حقل منفصل).
  - **الإلغاء المزدوج:** إلغاء صف `voided=true` مرة ثانية ⇒ **لا-op واضح** (`200` مع الحالة الحالية) أو `409` — لا يتغيّر `voided_at/voided_by/void_reason` الأول، ولا يُنشَأ حدث مكرر في التدقيق.
  - **التقارير:** الإلغاء يظهر كحالة مستقلة؛ التقارير التاريخية **تميّز** بين التسليم الأصلي والسجل الملغى (`voided`)، ولا يُحتسب الملغى تسليمًا صحيحًا، ولا يُمحى السجل.
  - **التدقيق:** `audit_log` `customer_po.delivery.voided` (مع السبب والفاعل والوقت) — مرة واحدة فقط.
  - **لا خلط:** إلغاء سجل تسليم ≠ إلغاء بند PO ≠ إلغاء بند RFQ ≠ رفض التوريد.
- **لا حذف لسجلات التسليم التاريخية** — إزالة الحذف المسبق في البوت (routes.ts:1297)، واستبدال DELETE route (deliveries.ts:429) بالإلغاء الناعم.
- **الملفات المتأثرة:** `customer-po/routes.ts`, `customer-po/deliveries.ts`, `communications/routes.ts`, `reports/item-kpis.ts`, `customer-rfq/routes.ts`, `lib/db/src/schema/receipts_deliveries.ts`.

---

## 6. ذرية Transaction والأقفال (النقطة 5)

```
BEGIN TRANSACTION
  1) INSERT customer_pos RETURNING id                         -- رأس PO
  2) INSERT customer_po_items ...                             -- البنود
  3) INSERT audit_log (customer_po.created)                   -- التدقيق (داخل المعاملة)
  4) customerRfqItemIds = distinct بنود لها customer_rfq_item_id
     رتّب تصاعديًا: sort(customerRfqItemIds)                  -- منع Deadlock
     لكل id بالترتيب:
        SELECT ... FROM customer_rfq_items WHERE id = X FOR UPDATE
        IF attribution_first_po_at IS NOT NULL THEN CONTINUE
        ref_ts := clock_timestamp()
        owner  := صاحب الفترة التي تغطّي ref_ts
        UPDATE customer_rfq_items SET attribution_first_po_at=ref_ts,
               attribution_employee_id=owner.id, attribution_employee_name=owner.name,
               attribution_event='customer_po_registered'
         WHERE id = X AND attribution_first_po_at IS NULL
COMMIT
-- بعد الـCOMMIT فقط: إرسال WhatsApp/البريد (خارج المعاملة)
```

- **ذرّي:** رأس PO + البنود + تثبيت الإنجاز + التدقيق. لا PO بلا إنجاز، ولا إنجاز بلا PO.
- **الأقفال تصاعدية** (`customer_rfq_item_id ASC`) ⇒ تقليل Deadlock.
- **الإشعارات الخارجية بعد نجاح المعاملة** — لا تُرسَل داخل Transaction.
- **تغيير المسؤول:** نفس القفل على نفس الصف، `clock_timestamp()` بعد القفل، إغلاق الفترة القديمة + فتح جديدة + Audit في نفس المعاملة.

### 6.1 لحظة التثبيت الواحدة `freezeAt` (النقطة 3.أ — مُثبَّت)

- لكل بند، **بعد الحصول على القفل**، تُحدَّد لحظة واحدة `freezeAt = clock_timestamp()`، وتُستخدم في **كل** ما يلي:
  - `attribution_first_po_at = freezeAt`
  - تحديد فترة الإسناد السارية: `valid_from <= freezeAt AND (valid_to IS NULL OR freezeAt < valid_to)`
  - `attribution_employee_id` + لقطة `attribution_employee_name` من تلك الفترة
- يمنع اختلاف وقت تحديد الموظف عن وقت تسجيل الإنجاز (نفس اللحظة للجميع).

### 6.2 حماية ارتباط Customer PO (النقطة 3.ب)

- **الوضع الحالي:** `customer_po_items.customer_rfq_item_id` → `ON DELETE SET NULL` (`customer_pos.ts:47`) ⇒ حذف بند RFQ (مباشر/إداري) يمحو ربط أمر الشراء بالبند الأصلي.
- **القرار:** تحويله إلى **`ON DELETE RESTRICT`** لحماية الارتباط التاريخي على مستوى قاعدة البيانات:
  ```
  ALTER TABLE customer_po_items DROP CONSTRAINT IF EXISTS customer_po_items_customer_rfq_item_id_fkey;
  ALTER TABLE customer_po_items ADD CONSTRAINT customer_po_items_customer_rfq_item_id_fkey
    FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT;
  ```
- **التوافق:** مسارات حذف بنود RFQ تُحوَّل إلى تعطيل؛ البنود بلا ربط (`NULL`) غير متأثرة.
- **ملاحظة:** يجب فحص الإنتاج لوجود بنود RFQ مرتبطة بأوامر شراء **قبل** تطبيق القيد (preflight SELECT).

### 6.3 لقطة `voided_by_name` (النقطة 3.ج)

- تُحفظ **وقت الإلغاء** من اسم الموظف الحالي، و**لا تتغيّر** إذا تغيّر الاسم لاحقًا (عمود نصي مستقل، لا مرجع حيّ).

---

## 7. Migration وinit-db.ts (النقطة 6)

### 7.1 Migration (جمل مستقلة، idempotent)

1. فحص قراءة فقط: `pg_available_extensions` لـ`btree_gist` + فحص التداخل (المقطع 9).
2. `CREATE EXTENSION IF NOT EXISTS btree_gist;` (إن سُمح).
3. `ALTER TABLE customer_rfq_items ADD COLUMN IF NOT EXISTS attribution_first_po_at/attribution_employee_id/attribution_employee_name/attribution_event/is_cancelled`.
4. `ALTER TABLE customer_rfq_item_assignments ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ` — **بلا `DEFAULT NOW()`**؛ القيمة تُملأ صراحةً بـ`clock_timestamp()` (خطوة 5) والافتراضي النهائي `clock_timestamp()` (المقطع 3). لا يُستخدم `NOW()` في أي لحظة إسناد.
5. Backfill: `UPDATE ... SET valid_from = COALESCE(assigned_at, clock_timestamp()) WHERE valid_from IS NULL;` ثم `SET NOT NULL` + `SET DEFAULT clock_timestamp()` (المقطع 3).
6. `DROP INDEX IF EXISTS customer_rfq_item_assignments_item_uq;` ثم `CREATE UNIQUE INDEX ... WHERE valid_to IS NULL;`
7. `ALTER TABLE ... ADD CONSTRAINT ... EXCLUDE USING gist (...)` (بعد فحص التداخل).
8. `ALTER TABLE customer_rfq_items ADD CONSTRAINT attribution_employee_fk ... ON DELETE RESTRICT`.
9. **FK الإسناد (موظف):** `DROP CONSTRAINT IF EXISTS ..._employee_id_fkey;` ثم `ADD CONSTRAINT ... FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT`.
10. **FK الإسناد (بند RFQ):** `DROP CONSTRAINT IF EXISTS ..._customer_rfq_item_id_fkey;` ثم `ADD CONSTRAINT ... FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT`.
11. `ALTER TABLE customer_po_item_deliveries ADD COLUMN IF NOT EXISTS idempotency_key` + **`operation_key`** + `payload_hash` + **`wa_message_id`** + `voided` + `voided_at/void_reason` + `voided_by` (FK RESTRICT) + `voided_by_name` + **الفهرس الفريد `(operation_key, customer_po_item_id)`** + الفهرس الفريد الجزئي `(customer_po_item_id, idempotency_key)` + الفهرس الفريد الجزئي `(wa_message_id)` (يمنع إعادة معالجة نفس الـWebhook).
12. **FK ارتباط PO:** `DROP CONSTRAINT IF EXISTS customer_po_items_customer_rfq_item_id_fkey;` ثم `ADD CONSTRAINT ... FOREIGN KEY (customer_rfq_item_id) REFERENCES customer_rfq_items(id) ON DELETE RESTRICT` (بعد preflight).
13. **Backfill الإنجاز: لا اختراع** (الأعمدة تبقى NULL).

### 7.2 سلامة `init-db.ts` عند إعادة التشغيل

- كل الجمل `IF NOT EXISTS`/`IF EXISTS` ⇒ **إعادة التشغيل لا تعيد إنشاء ولا تصفّر** بيانات الإسناد/الإنجاز/مفاتيح التسليم.
- لا `TRUNCATE`/`DROP TABLE`/`DELETE` لأي جدول تشغيلي في التهيئة.
- **اختبار:** تشغيل `initDb()` مرتين متتاليتين ⇒ عدد الصفوف في `customer_rfq_item_assignments`/`customer_rfq_items`/`customer_po_item_deliveries` **لا يتغيّر**.

### 7.2.1 قابلية إعادة التنفيذ بعد توقف جزئي (النقطة 2 — مُغلقة)

`IF NOT EXISTS` **لا يكفي** للقيود (`ADD CONSTRAINT ... EXCLUDE` / FK) — إعادة التشغيل بعد نجاحها تفشل بـ«already exists». المطلوب **فحص الكتالوج قبل كل إضافة**، مع التحقق من **التعريف** لا الاسم فقط:

```sql
-- قيد EXCLUDE: قارن التعريف الفعلي (pg_get_constraintdef) لا الاسم فقط.
-- إن وُجد باسم صحيح لكن بتعريف خاطئ ⇒ DROP ثم إعادة الإنشاء.
DO $$
DECLARE
  actual text;
  expected text :=
    'EXCLUDE USING gist (customer_rfq_item_id WITH =, tstzrange(valid_from, COALESCE(valid_to, ''infinity''::timestamp with time zone), ''[)''::text) WITH &&)';
BEGIN
  SELECT pg_get_constraintdef(oid) INTO actual
    FROM pg_constraint
   WHERE conname = 'customer_rfq_item_assignments_no_overlap'
     AND conrelid = 'customer_rfq_item_assignments'::regclass;
  IF actual IS NULL THEN
    ALTER TABLE customer_rfq_item_assignments
      ADD CONSTRAINT customer_rfq_item_assignments_no_overlap
      EXCLUDE USING gist (customer_rfq_item_id WITH =,
        tstzrange(valid_from, COALESCE(valid_to,'infinity'),'[)') WITH &&);
  ELSIF actual <> expected THEN
    ALTER TABLE customer_rfq_item_assignments
      DROP CONSTRAINT customer_rfq_item_assignments_no_overlap;
    ALTER TABLE customer_rfq_item_assignments
      ADD CONSTRAINT customer_rfq_item_assignments_no_overlap
      EXCLUDE USING gist (customer_rfq_item_id WITH =,
        tstzrange(valid_from, COALESCE(valid_to,'infinity'),'[)') WITH &&);
  END IF;
END $$;

-- FK: قارن المرجع + الإجراء (confrelid + confdeltype='r' = RESTRICT)، لا الاسم فقط.
DO $$
DECLARE
  has_wrong boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='customer_rfq_item_assignments'::regclass
      AND c.contype='f' AND a.attname='employee_id'
      AND (c.confrelid <> 'employees'::regclass OR c.confdeltype <> 'r')
  ) INTO has_wrong;
  IF has_wrong THEN
    ALTER TABLE customer_rfq_item_assignments
      DROP CONSTRAINT customer_rfq_item_assignments_employee_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='customer_rfq_item_assignments'::regclass
      AND c.contype='f' AND a.attname='employee_id'
      AND c.confrelid='employees'::regclass AND c.confdeltype='r'
  ) THEN
    ALTER TABLE customer_rfq_item_assignments
      ADD CONSTRAINT customer_rfq_item_assignments_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- فهرس: قارن التعريف الفعلي (pg_indexes.indexdef) لا الاسم فقط.
SELECT indexdef FROM pg_indexes
 WHERE tablename='customer_rfq_item_assignments'
   AND indexname='customer_rfq_item_assignments_open_uq';
-- إن كان التعريف مختلفًا عمّا هو مطلوب (عمود/شرط WHERE) ⇒ DROP INDEX ثم CREATE من جديد.
```

- **كل خطوة مستقلة وقابلة للاستكمال:** إعادة التشغيل بعد توقف جزئي تكمل من حيث توقفت (الفحص يتخطى ما نُفّذ).
- **التحقق من التعريف (لا الاسم فقط):** يُقارَن تعريف القيد الفعلي (`pg_get_constraintdef`) والمرجع/الإجراء (`pg_constraint.confrelid/confdeltype`) وتعريف الفهرس (`pg_indexes.indexdef`) بالمطلوب. **القيد الموجود باسم صحيح لكن بتعريف خاطئ يُكتشف ويُصحَّح** (DROP + إعادة إنشاء). اختبار 41 يغطي هذه الحالة.
- **Backfill لا يُعاد على بيانات معتمدة:** خطوة `UPDATE ... SET valid_from = COALESCE(...)` مشروطة بـ`WHERE valid_from IS NULL` ⇒ إعادة التشغيل لا تعيد كتابة تواريخ صفوف سبق ترحيلها. ونفس المبدأ لبقية خطوات Backfill (لا إعادة تنفيذ على بيانات مكتملة).
- **`DROP` المسموح vs الممنوع:** **مسموح** إسقاط **فهرس/قيد قديم محدَّد** لاستبداله (`DROP INDEX ..._item_uq`، `DROP CONSTRAINT ..._fkey`)؛ **ممنوع** `DROP TABLE`/`DROP COLUMN`/`DELETE`/`TRUNCATE` لأي بيانات تشغيلية.
- **اختبار التوقف/الاستكمال بعد كل مرحلة:** يُوقف Migration عند نهاية **كل** خطوة، ثم يُعاد تشغيله ⇒ يكتمل دون أخطاء «already exists»، ودون فقد/تغيير بيانات (اختبار 40/41)، ودون إعادة Backfill على صفوف سبق اعتمادها.

### 7.3 Rollback

- **لا حذف لأي عمود يحمل بيانات تشغيلية** (`attribution_*`, `idempotency_key`).
- الأعمدة additive ⇒ **التراجع الآمن = تعطيل الميزة أو Roll-forward**.
- إسقاط **قيد** فقط (FK/EXCLUDE) مسموح (لا يفقد بيانات).
- **Backup إلزامي** قبل الخطوات 4-9.

---

## 8. المخطط النهائي المختصر

**`customer_rfq_items`:** `attribution_first_po_at`, `attribution_employee_id` (FK RESTRICT), `attribution_employee_name`, `attribution_event`, `is_cancelled`.

**`customer_rfq_item_assignments`:** `valid_from` (NOT NULL، افتراضي `clock_timestamp()`), `valid_to`؛ استبدال الفهرس المطلق بجزئي؛ قيد `EXCLUDE gist` للتداخل؛ **FK `employee_id` → `RESTRICT`**؛ **FK `customer_rfq_item_id` → `RESTRICT`** (حماية تاريخ الإسناد).

**`customer_po_item_deliveries`:** `idempotency_key` + **`operation_key`** + **`payload_hash`** (بصمة الطلب الكامل) + **`wa_message_id`** + **فهرس فريد `(operation_key, customer_po_item_id)`** + فهرس فريد جزئي `(customer_po_item_id, idempotency_key)` + فهرس فريد جزئي `(wa_message_id)`؛ `voided/voided_at/void_reason` + `voided_by` (FK `RESTRICT`) + `voided_by_name` (لقطة) للإلغاء الناعم.

**`customer_po_items`:** `customer_rfq_item_id` FK → **`RESTRICT`** (حماية ارتباط PO بالبند الأصلي).

**فئات الإنجاز:** محسوم / جديد غير محسوم (مقفول) / تاريخي غير محسوم (له PO) / سجل بلا ربط RFQ.

---

## 9. Preflight (SELECT فقط — لم يُنفَّذ هنا)

```sql
-- 1) توفر btree_gist
SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name='btree_gist';
-- 2) فترات مفتوحة مكررة
SELECT customer_rfq_item_id, count(*) FROM customer_rfq_item_assignments GROUP BY 1 HAVING count(*)>1;
-- 3) تداخل تاريخي (بعد إضافة الفترات)
SELECT a.id,b.id FROM customer_rfq_item_assignments a JOIN customer_rfq_item_assignments b
  ON a.customer_rfq_item_id=b.customer_rfq_item_id AND a.id<b.id
WHERE tstzrange(a.valid_from,COALESCE(a.valid_to,'infinity'),'[)')
   && tstzrange(b.valid_from,COALESCE(b.valid_to,'infinity'),'[)');
-- 4) وجود بنود RFQ مرتبطة بأوامر شراء (قبل FK RESTRICT لارتباط PO)
SELECT count(*) FROM customer_po_items WHERE customer_rfq_item_id IS NOT NULL;
```

> **الوصول للإنتاج غير متاح من هذه البيئة** (`DATABASE_URL` غير مضبوط) ⇒ لم يُشغَّل أي فحص.

---

## 10. الملفات المتأثرة

`lib/db/src/schema/{customer_rfqs,item_categories,receipts_deliveries}.ts`، `shared/init-db.ts`، `modules/users/auth.ts`، `modules/customer-rfq/routes.ts`، `modules/customer-po/routes.ts`، `modules/customer-po/deliveries.ts`، `modules/rfq/customer-assignment.ts`، `modules/rfq/assignment.ts`، `modules/communications/{service,routes}.ts`، `artifacts/rfq-portal/src/modules/customer-po/pages/deliveries.tsx`، `modules/reports/item-kpis.ts`.

---

## 11. اختبارات القبول (51)

| #   | السيناريو                                      | المتوقع                                       | الطبقة       |
| --- | ---------------------------------------------- | --------------------------------------------- | ------------ |
| 1   | PO مرتبط ببند له مسؤول                         | إنجاز فوري                                    | PGlite       |
| 2   | فشل إدراج البنود                               | لا رأس PO ولا إنجاز                           | PGlite       |
| 3   | فشل التثبيت بعد البنود                         | لا PO                                         | PGlite       |
| 4   | تعدد بنود/PO لنفس البند                        | إنجاز=1                                       | PGlite       |
| 5   | نقل المسؤول بعد التثبيت                        | الإنجاز ثابت                                  | PGlite       |
| 6   | أول PO بلا مسؤول ثم إسناد ثم PO                | يبقى غير محسوم                                | PGlite       |
| 7   | بند قديم له PO بلا حقول                        | «تاريخي غير محسوم»                            | PGlite       |
| 8   | PO بلا `customer_rfq_item_id`                  | «يتعذّر تحديد بندها»                          | PGlite       |
| 9   | تعطيل موظف له إنجاز                            | الإنجاز + اللقطة يبقيان                       | PGlite       |
| 10  | حذف موظف له إنجاز                              | يمنعه FK RESTRICT                             | **Postgres** |
| 11  | تزامن: PO + تغيير مسؤول                        | نتيجة حتمية                                   | **Postgres** |
| 12  | فترتان متداخلتان                               | يمنعه EXCLUDE                                 | **Postgres** |
| 13  | ضغط زر مرتين متزامنتين                         | صف واحد (قيد DB)                              | **Postgres** |
| 14  | سؤال جديد لتسليم جزئي                          | رمز جديد ⇒ مستقل                              | PGlite       |
| 15  | Refresh قبل النتيجة ثم إعادة إرسال             | صف واحد (يعيد النتيجة)                        | PGlite       |
| 16  | نفس المفتاح بكمية مختلفة                       | رفض 409                                       | PGlite       |
| 17  | نجاح الخادم + توقف الصفحة ثم تسليم جديد        | مفتاح جديد ⇒ مستقل                            | PGlite       |
| 18  | إعادة تشغيل initDb مرتين                       | لا تغيير في عدد الصفوف                        | PGlite       |
| 19  | إلغاء بند له إنجاز                             | الإنجاز + سجلات التسليم تبقى                  | PGlite       |
| 20  | طول حِمْل الزر                                 | ≤ 256                                         | PGlite       |
| 21  | حذف موظف **له فترات إسناد** (بلا إنجاز)        | يمنعه FK RESTRICT على الإسناد                 | **Postgres** |
| 22  | إلغاء سجل تسليم (void)                         | الصف يبقى، الكمية تُستبعد                     | PGlite       |
| 23  | طلب متعدد البنود بنفس `operationKey`           | لا تكرار لأي بند نجح                          | PGlite       |
| 24  | إعادة إرسال نفس المفتاح بمحتوى مختلف           | 409، ولا إدراج                                | PGlite       |
| 25  | إعادة إرسال نفس المفتاح بمحتوى مطابق           | يُعاد الصف الأصلي (لا إدراج)                  | PGlite       |
| 26  | طلبان متزامنان بنفس المفتاح                    | سجل واحد (قيد DB)                             | **Postgres** |
| 27  | فشل بند واحد داخل الطلب                        | rollback كامل (لا حفظ جزئي)                   | PGlite       |
| 28  | إلغاء سجل ثم إلغاؤه ثانية                      | لا-op/409، لا تغيير الحقول                    | PGlite       |
| 29  | إلغاء سجل تسليم                                | `delivered_at` الأصلي ثابت                    | PGlite       |
| 30  | إلغاء سجل تسليم                                | سطر تدقيق واحد فقط                            | PGlite       |
| 31  | عمليتا إسناد متزامنتان (بلا btree_gist)        | القفل يمنع التداخل — **في كل مسارات الكتابة** | **Postgres** |
| 32  | تقرير تاريخي على سجل ملغى                      | يميّز الملغى عن الصحيح                        | PGlite       |
| 33  | حذف بند Customer RFQ له فترات إسناد            | يمنعه FK RESTRICT                             | **Postgres** |
| 34  | تعطيل بند Customer RFQ له فترات إسناد          | ينجح دون حذف التاريخ                          | PGlite       |
| 35  | إعادة `operationKey` بمجموعة بنود مختلفة       | 409 (اختلاف مجموعة البنود)                    | PGlite       |
| 36  | `assigned_at` فارغ عند Backfill                | `valid_from` يُعبّأ، لا NULL                  | PGlite       |
| 37  | حذف موظف له سجل إلغاء تسليم                    | لا تضيع هوية منفذ الإلغاء                     | **Postgres** |
| 38  | إعادة تشغيل `initDb()` بعد بيانات فعلية        | لا فقد/تغيير غير مقصود                        | PGlite       |
| 39  | `operationKey` بمجموعة بنود **أصلية أكبر**     | البحث بـ`operation_key` يجد الكل ⇒ 409        | PGlite       |
| 40  | إعادة Migration بعد توقف جزئي                  | تكتمل دون «already exists»                    | **Postgres** |
| 41  | قيد/فهرس موجود بتعريف مختلف                    | يُكتشف ويُصحَّح (تعريف لا اسم)                | **Postgres** |
| 42  | حذف بند RFQ مرتبط بـCustomer PO                | يمنعه FK RESTRICT                             | **Postgres** |
| 43  | تغيير اسم الموظف بعد الإلغاء                   | `voided_by_name` اللقطة ثابتة                 | PGlite       |
| 44  | `freezeAt` واحد لكل بند                        | الموظف والفترة بنفس اللحظة                    | PGlite       |
| 45  | إعادة الإرسال بمفتاحه بعد **حذف بند** من الأصل | `operation_key` يجد البند المحذوف ⇒ 409       | PGlite       |
| 46  | توقف Migration بعد بعض القيود ثم استكماله      | تكتمل، ولا Backfill مكرر                      | **Postgres** |
| 47  | تغيير مسؤول **متزامن** مع تسجيل أول PO         | صاحب الإنجاز ثابت (نفس `freezeAt`)            | **Postgres** |
| 48  | طلبان متزامنان بنفس `operation_key`            | يصطدمان على الفهرس الفريد (عملية واحدة)       | **Postgres** |
| 49  | قيد/فهرس موجود باسم صحيح وتعريف خاطئ           | يُكتشف ويُصحَّح (تعريف لا اسم)                | **Postgres** |
| 50  | أول PO **بلا مسؤول** ثم إسناد ثم PO ثانٍ       | يبقى غير محسوم (لا يُنسب)                     | PGlite       |
| 51  | اكتمال التوريد دون تأكيد عميل                  | لا تُضاف حقول/خطوة تأكيد                      | PGlite       |

---

## 12. المخاطر والاعتماديات

| الخطر                                   | التخفيف                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `btree_gist` غير متاح/غير مسموح         | فحص `pg_available_extensions`؛ بديل تطبيقي + اختبار تزامن |
| تداخل تاريخي في الإنتاج                 | preflight SELECT قبل القيد                                |
| الإسنادات الحالية بلا تاريخ حقيقي       | `assigned_at` كتاريخ موثق؛ لا تُستخدم لإنجازات قديمة      |
| Deadlock عند PO متعدد البنود            | ترتيب الأقفال تصاعديًا                                    |
| تكرار متزامن                            | قيد فريد في DB (الحماية النهائية)                         |
| `cancelled` خارج نطاق `delivery_status` | فصل مصادر الإلغاء                                         |
| حذف سجلات تسليم                         | إزالة الحذف المسبق؛ استبدال DELETE بإلغاء ناعم (void)     |
| حذف موظف يمحو تاريخ الإسناد             | FK `employee_id` → RESTRICT + تعطيل الموظف                |
| حذف بند RFQ يمحو فترات الإسناد          | FK `customer_rfq_item_id` → RESTRICT + تعطيل البند        |
| بديل btree_gist حماية تطبيقية فقط       | جرد كل مسارات الكتابة + القفل؛ ليست ضمانة DB              |
| إعادة تشغيل initDb على بيانات فعلية     | اختبار صريح (لا فقد/تصفير)                                |
| إعادة Migration بعد توقف جزئي           | فحص الكتالوج (pg_constraint/pg_indexes) قبل كل قيد/فهرس   |
| اكتشاف تغيير مجموعة البنود              | `operation_key` + `payload_hash` والبحث بـ`operation_key` |
| حذف بند RFQ يمحو ارتباط PO              | FK `customer_po_items.customer_rfq_item_id` → RESTRICT    |

**ما لم يُثبَت:**

- توفر `btree_gist` وصلاحيات الإنتاج (يحتاج فحصًا).
- وجود تداخل تاريخي فعلي (يحتاج SELECT على الإنتاج).
- `context.id` لضغط الأزرار (يحتاج التقاط Webhook حقيقي).

---

## 13. ترتيب التنفيذ

| المرحلة | العمل                                                               |
| ------- | ------------------------------------------------------------------- |
| P0-1    | Preflight (btree_gist + التداخل)                                    |
| P0-2    | فترات الإسناد + استبدال الفهرس + EXCLUDE + Backfill                 |
| P0-3    | أعمدة `attribution_*` + FK RESTRICT + `is_cancelled` + FK ارتباط PO |
| P0-4    | Transaction + `freezeAttribution` (freezeAt + ترتيب الأقفال)        |
| P0-5    | قفل تغيير المسؤول + إغلاق/فتح الفترات                               |
| P1-1    | تعطيل الموظف + بنود RFQ + حماية الحذف                               |
| P1-2    | idempotency (`operation_key` + البوت + الصفحة)                      |
| P1-3    | التقارير (الفئات + فصل الإلغاء)                                     |
| P2      | اختبارات Postgres + migration جزئي/كامل على نسخة معزولة             |

---

> **لا تعتبر هذه الخطة موافقة على التنفيذ.** لا يُنفَّذ أي تعديل على الكود أو قاعدة البيانات قبل موافقة مستقلة صريحة.

---

## 14. حالة التنفيذ (مُحدَّثة)

نُفِّذت الخطة على فرع العمل (بدون commit/push/deploy). الحالة الفعلية:

| المرحلة                                                                  | الحالة | الدليل                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-2 فترات الإسناد + استبدال الفهرس + EXCLUDE + Backfill                 | ✅     | `init-db.ts` — `DROP INDEX …item_uq` + `…open_uq (… WHERE valid_to IS NULL)` + `EXCLUDE USING gist` بفحص `pg_get_constraintdef` + فحص `pg_available_extensions` |
| P0-3 أعمدة `attribution_*` + FK RESTRICT + `is_cancelled` + FK ارتباط PO | ✅     | `init-db.ts` + `customer_rfqs.ts` + مقارنة `confdeltype` قبل كل FK                                                                                              |
| P0-4 Transaction + `freezeAttribution` (freezeAt + ترتيب الأقفال)        | ✅     | `customer-po/routes.ts` (`db.transaction` + `lockItemRows`) + `rfq/attribution.ts`                                                                              |
| P0-5 قفل تغيير المسؤول + إغلاق/فتح الفترات                               | ✅     | `rfq/customer-assignment.ts` (`closeAndOpenPeriod` داخل transaction + Audit)                                                                                    |
| P1-1 تعطيل الموظف + بنود RFQ + حماية الحذف                               | ✅     | `users/auth.ts` (soft-disable) + `customer-rfq/routes.ts` (soft-cancel) + `is_cancelled`                                                                        |
| P1-2 idempotency (`operation_key` + البوت + الصفحة)                      | ✅     | `customer-po/deliveries.ts` (operationKey/payloadHash + إلغاء ناعم) + `communications/routes.ts`                                                                |
| P1-3 التقارير (الفئات + فصل الإلغاء)                                     | ✅     | `reports/item-kpis.ts` (فلترة الفترة المفتوحة + استبعاد الملغى)                                                                                                 |
| P2 اختبارات + migration جزئي/كامل                                        | ✅     | اختبارات الوحدة تمر (1330 api-server / 62 portal) + **12 اختبار Postgres حيّ** يمرّون مقابل قاعدة بيانات حقيقية                                                 |

**حرّاس TDD (فشلوا قبل الإصلاح، تم التحقق بمحاكاة الرجوع):**

- `customer-rfq.test.ts` → soft-cancel (كان يحذف فعليًا).
- `deliveries-idempotency.test.ts` (7) → operationKey + إلغاء ناعم (6 تفشل قبل الإصلاح).
- `customer-po.test.ts` → تجميد الإنجاز (يفشل قبل الإصلاح).
- `auth.test.ts` → تعطيل الموظف بدل الحذف (يفشل قبل الإصلاح).
- `init-db.test.ts` → الفهرس المفتوح + RESTRICT + تعريف القيود + أعمدة الإلغاء (تفشل قبل الإصلاح).

**ملاحظات تنفيذية:**

- كل الـ DDL في `init-db.ts` فقط (لا `drizzle-kit push`)؛ الجمل مستقلة وقابلة لإعادة التنفيذ.
- `tsc --build` + api-server + portal نظيفة؛ prettier على كل المستودع نظيف.
- لم يُنفَّذ أي commit/push/deploy التزامًا بالقيود.

**اختبارات Postgres الحيّة (P2 — مُنجزة):** ملفّان يعملان فقط عند ضبط `TEST_DATABASE_URL`
(وإلا يُتخطّيان، فتبقى CI بلا قاعدة بيانات خضراء):

- `init-db.live.test.ts` (9) — الفهرس الجزئي، قيد `EXCLUDE USING gist`، FK RESTRICT، الأعمدة
  الجديدة، فرض «فترة مفتوحة واحدة»، رفض التداخل، **إعادة التشغيل الآمنة (idempotent)**،
  **الاستئناف بعد migration جزئي**، و**استبدال قيد تعريفه خطأ**.
- `attribution.live.test.ts` (3) — `closeAndOpenPeriod` (إغلاق/فتح)، `freezeAttributionForItem`
  (تجميد مرّة واحدة لا يُعاد)، وقفل `FOR UPDATE` حقيقي يُلزم كاتبًا متزامنًا بالانتظار.

كل ملف في **schema منفصل** (`live_mig` / `live_attr`) ليعملا بالتوازي دون تدمير جداول بعضهما.

> **عيب حقيقي كشفه الاختبار الحيّ:** كان `initDb()` يفشل على قاعدة جديدة/إعادة تشغيل —
> `INSERT … ON CONFLICT (customer_rfq_item_id)` كان يستهدف الفهرس المطلق القديم الذي
> استُبدل بالفهرس الجزئي، فيرمي `no unique or exclusion constraint matching the ON CONFLICT
specification`. الإصلاح: `ON CONFLICT (customer_rfq_item_id) WHERE valid_to IS NULL DO NOTHING`
> (المُسند يطابق الفهرس الجزئي)، مع حارس وحدة في `init-db.test.ts` يفشل على الصيغة القديمة.

---

## 15. تعديلات القرارات — مناقشة 2026-10-05 (تصميم مقترح — **لم يُنفَّذ**)

> **الحالة:** تصميم للمناقشة فقط. **لا تعديل على الكود ولا الـDDL.** يُلغي هذا القسم أجزاءً
> من §0 و§5 (نموذج «مسؤول واحد للبند» و«أول PO يفوز») ويُبقي الباقي (فترات الإسناد،
> soft-disable، idempotency، التجريم/الاستبعاد).

### 15.1 القرارات الجديدة (من المشغّل)

| #   | القرار                                                                          | الأثر على التصميم                                                               |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| N1  | **بند العميل قد ينتمي لأكثر من تصنيف** (علاقة متعدد-لمتعدد).                    | إلغاء `customer_rfq_items.category_id` كحقل واحد ⇒ جدول ربط بند×تصنيف.          |
| N2  | **لكل تصنيف مسؤول**؛ البند متعدد التصنيفات ⇒ **متعدد المسؤولين** (مسؤول/تصنيف). | إلغاء «مسؤول واحد للبند» ⇒ مفتاح الإسناد يصبح **(بند، تصنيف)** لا البند وحده.   |
| N3  | **الفائز = من جاب السعر، وجاب PO من العميل، واتنفّذ** — لا «أول PO».            | إلغاء §5.2/§5.4 («الإنجاز يُقفل من أول PO») ⇒ الحسم عند اكتمال التنفيذ.         |
| N4  | **الاختصاصات قابلة للتعديل في أي وقت** (بلا قفل؛ فترات تاريخية تحفظ الماضي).    | يُبقى `closeAndOpenPeriod` لكن على **(بند، تصنيف)**، مع «قفل الفائز» عند الحسم. |

### 15.2 أين يتعارض ذلك مع التنفيذ الحالي (أدلة من الكود — فحص فعلي)

| المكوّن                 | الملف/السطر                                            | الحقيقة الحالية                                        | التعارض |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ------- |
| تصنيف البند             | `lib/db/src/schema/customer_rfqs.ts:42`                | `categoryId` **حقل واحد**                              | N1      |
| فهرس الإسناد المفتوح    | `lib/db/src/schema/item_categories.ts:188`             | `UNIQUE (customer_rfq_item_id) WHERE valid_to IS NULL` | N2      |
| اختيار المسؤول          | `modules/rfq/customer-assignment.ts:37`                | `pickOwner` يرجّع **موظفًا واحدًا** للتصنيف            | N2      |
| تجميد الإنجاز           | `customer_rfqs.ts:50-53` + `rfq/attribution.ts`        | `attribution_employee_id` **واحد** على البند           | N2/N3   |
| تجميد الإنجاز من أول PO | `customer-po/routes.ts` (freezeAttribution)            | يُقفل من **أول** PO ولا يُعاد نسبته                    | N3      |
| KPI                     | `modules/reports/item-kpis.ts:78`                      | يقرأ الإسناد المفتوح ويجمّع بـ`employeeId`             | N2/N3   |
| جدول الإسناد            | `lib/db/src/schema/item_categories.ts:159`             | يحمل `category_id` **بالفعل** ⇒ يسهّل التحويل لـN2     | ✅      |
| التصنيف الآلي           | `modules/rfq/classification.ts:210`                    | `classifyItem` يرجّع **تصنيفًا واحدًا** (أعلى ثقة)     | N1      |
| الاختصاصات              | جدول `employee_categories` (موظف×تصنيف + `is_primary`) | موجود، لكن **غير مُعبَّأ** حاليًا                      | N4      |

**الخلاصة:** البنية الحالية مبنية على «مسؤول واحد لكل بند» و«أول PO يفوز». تنفيذ N1–N3
يستلزم **تعديل مفتاح الإسناد** (إضافة التصنيف للمفتاح) و**جدول ربط للتصنيفات** و**تغيير
قاعدة الحسم** — تعديل مُوجَّه، لا إعادة كتابة (جدول الإسناد يحمل `category_id` أصلًا).

### 15.3 التصميم المقترح

1. **جدول ربط التصنيفات** `customer_rfq_item_categories (customer_rfq_item_id, category_id)`
   بـ`UNIQUE(customer_rfq_item_id, category_id)`؛ يبقى `customer_rfq_items.category_id`
   كـ«تصنيف أساسي» للعرض/التوافق (أو يُهمَل). المصنّف يُطوَّر ليرجّع **قائمة مرشحين**
   (كل تصنيف تجاوز العتبة)، والبند بلا تصنيف يبقى بلا مسؤول.
2. **مفتاح الإسناد** يصبح `(customer_rfq_item_id, category_id)`:
   - الفهرس المفتوح: `UNIQUE (customer_rfq_item_id, category_id) WHERE valid_to IS NULL`.
   - `pickOwner` يعمل **لكل تصنيف على حدة** ⇒ البند يحصل على مسؤول لكل تصنيف.
   - التجاوز اليدوي (`assignCustomerItemManually`) يقبل تصنيفًا + موظفًا (لا موظفًا واحدًا).
3. **حسم الفائز (N3):** دالة `resolveItemCompetition(itemId)` تفحص إسنادات البند المفتوحة
   وتُرجّع لكل تصنيف: هل جاب سعر؟ هل فيه PO من العميل؟ هل اتنفّذ؟ **الفائز = صاحب آخر إسناد
   كان سارٍ وقت اكتمال التنفيذ** (لا أول PO). تُكتب مرة واحدة: `is_winner`/`won_at`/`won_po_id`
   على الإسناد الفائز (أو جدول `customer_rfq_item_competition` منفصل للأوضح).
4. **الحسم لا يُعاد فتحه:** يُقفل عند أول اكتمال تنفيذ (نفس مبدأ §5.2 لكن الشرط صار
   «اكتمال التنفيذ» لا «أول PO»). تغيير الاختصاص لاحقًا **لا يحرّك فائزًا محسومًا**.
5. **KPI:** يجمع على مستوى **البند** (بند واحد = إنجاز واحد مهما تعدد الموردون) لكن **يُنسب
   للفائز**، مع تقسيم اختياري لكل تصنيف (فوز/خسارة) لقياس المنافسة.

### 15.4 أسئلة مفتوحة (تحتاج قرار المشغّل قبل التنفيذ)

1. **تعريف «اتنفّذ»:** هل هو `customer_po_items.delivery_status='delivered'` (كما في §0/§5.4)،
   أم حالة تنفيذ أخرى (فاتورة بيع مُصدَرة/تحصيل)؟
2. **لو أمر العميل اتقسّم** على أكثر من بند/مورد — الفائز صاحب **البند** أم صاحب **الجزء الأكبر**؟
3. **هل الحسم نهائي؟** (لو اتغيّر الاختصاص بعد الحسم، الفائز يفضل زي ما هو؟) — الاقتراح: نعم.
4. **هل نبقي «أول PO» كمؤشر معلوماتي** (سرعة الاستجابة) مع تغيير «الفائز»؟ — الاقتراح: نعم، كعمود منفصل.
5. **التصنيف المتعدد:** يقتصر على **بند العميل** فقط، أم ينسحب كذلك على بنود الموردين
   (`rfq_items.category_id`) والعروض؟
6. **الاختصاصات الفارغة:** لو تصنيف بلا مالك وقت الاستلام ⇒ البند يبقى بلا مسؤول (كما الآن) —
   أم نطلب تعيينًا إجباريًا؟ — الاقتراح: يبقى بلا مسؤول + تنبيه في تقرير التغطية.

### 15.5 القرارات المؤكدة — الجولة الثانية (2026-10-05)

| #   | القرار (من المشغّل)                                                                                                | الأثر على التصميم                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| A1  | **«اتنفّذ» = المندوب سلّم للعميل** — عبر بوت الواتساب **أو** صفحة تسليمات العملاء (`customer_po_item_deliveries`). | شرط الفوز النهائي = وجود تسليم مسجَّل للبند (لا `delivery_status` النظري).                                   |
| A2  | **كل بند في أمر الشراء الوارد من العميل يُعامَل منفردًا** حتى لو الأمر فيه أكثر من بند.                            | المنافسة/الحسم على مستوى **البند** لا الأمر — يطابق «بند واحد = إنجاز واحد» ويقفل أي التباس لو الأمر اتقسّم. |
| A3  | **الحسم نهائي** (موافقة على الاقتراح): تغيير الاختصاص بعد الفوز **لا يحرّكه**.                                     | يُقفل الفائز عند أول تسليم؛ `closeAndOpenPeriod` يعمل على الإسنادات المفتوحة فقط.                            |
| A4  | **التصنيف المتعدد ينسحب كذلك على بنود الموردين والعروض** (لا يقتصر على بند العميل).                                | `rfq_items.category_id` و`offers`/`offer_items` يتحولان لنموذج متعدد-لمتعدد أيضًا (جدول ربط لكل مستوى).      |
| A5  | **تصنيف بلا مالك ⇒ البند بلا مسؤول + تنبيه** (موافقة على الاقتراح).                                                | لا تعيين إجباري؛ تقرير التغطية يُظهر التصنيفات بلا مالك والبنود المتأثرة.                                    |

**سؤال واحد معلّق (كان رقم ٤ ولم يُفهم):** هل نبقي «مين جاب **أول** أمر شراء من
العميل» كإحصائية **منفصلة** (مؤشر سرعة استجابة)، مع أن «الفائز» أصبح «مين سلّم»؟
أم نحذف «أول PO» تمامًا؟ (الاقتراح: نبقيه كعمود معلوماتي فقط، لا يُنسب له أي إنجاز.)

### 15.6 أثر A4 (التصنيف المتعدد على الموردين والعروض) على منطق «مين جاب السعر»

مع تعدد التصنيفات في كل المستويات، يصبح لكل **عرض** مسؤولون (حسب تصنيفاته). لذلك
قاعدة الفوز تُصاغ على مستوى **العرض المختار**:

1. بند العميل X ← تصنيفاته {C1, C2} ⇒ مسؤولون {A (C1), B (C2)}.
2. عرض من مورد لكل تصنيف (أو عرض واحد متعدد التصنيفات).
3. أمر العميل لـX ← يُربط ببند أمر مورد ← **العرض الذي تحوّل لأمر**.
4. التسليم (A1) ← **الفائز = مسؤول تصنيف العرض المُسلَّم**.
5. لو العرض المُسلَّم نفسه متعدد التصنيفات (A4) ⇒ يلزم حسم إضافي: هل يفوز **مالك
   المورد** أم **كل مالكي تصنيفات العرض**؟ — **سؤال مفتوح تالٍ** (يُطرح بعد إقرار
   المخطط، لا يؤثر على بقية التصميم).

---

## 16. المستويات الأربعة للمسؤولية والتصنيف — مناقشة 2026-10-05 (تصميم مقترح — **لم يُنفَّذ**)

> **الحالة:** تصميم للمناقشة فقط. **لا تعديل على الكود ولا الـDDL.** هذا القسم يُكمل §15
> ولا يُلغيه: §15 قرّر **ماذا** نريد (تصنيف متعدد، فائز بالتنفيذ، حسم نهائي، A1–A5)،
> وهذا القسم يُثبّت **على أي مستوى** يُطبَّق كل قرار — وهو السؤال الذي ظل مفتوحًا.

### 16.0 سبب وجود هذا القسم

طلب التسعير الواحد يحتوي تصنيفات مختلفة (أجهزة، قطع غيار، كهرباء، قواطع، مقاومة حريق)،
وكل تصنيف له مورد مختلف، وفريق المشتريات كل فرد مسؤول عن **تصنيفين أو أكثر**. سؤال
المشغّل: كيف يُحدَّد **النود المسؤول** آليًا بدل العمل اليدوي؟ والجواب ليس مستوى واحدًا بل
**أربعة مستويات** يجب تعريف المسؤول والفائز في كل منها بوضوح، وإلا بقي الغموض.

### 16.1 خريطة المستويات (مُشتقّة من الكود الفعلي — فحص)

| المستوى               | الجدول                   | التصنيف حاليًا             | المسؤول حاليًا                        | الفائز حاليًا         |
| --------------------- | ------------------------ | -------------------------- | ------------------------------------- | --------------------- |
| **L1** بند طلب العميل | `customer_rfq_items`     | `category_id` **حقل واحد** | `customer_rfq_item_assignments` (بند) | من أول PO (يُجمَّد)   |
| **L2** بند طلب المورد | `rfq_items`              | `category_id` **حقل واحد** | يُشتق من L1 (`customer_rfq_item_id`)  | —                     |
| **L3** العرض          | `offers` / `offer_items` | **لا يوجد**                | يُشتق من التصنيفات                    | العرض الذي تحوّل لـPO |
| **L4** المورد         | `suppliers`              | **لا يوجد**                | **لا يوجد** (لا يوجد «مسؤول مورد»)    | —                     |

**ملاحظة جوهرية:** L1 وL2 يحملان `category_id` كحقل واحد (يخالف N1/A4)، وL3 وL4 **بلا
تصنيف أصلًا**، وL4 **بلا مسؤول**. لذلك A4 («التصنيف المتعدد ينسحب على الموردين
والعروض») يعني **إنشاء مفهوم جديد** عند L3/L4، لا مجرد توسيع.

### 16.2 القرار المطلوب من المشغّل — ما معنى «مورد مختلف»؟

المشغّل قال: «كل تصنيف له **مورد مختلف**». هذا يفتح احتمالين، ويجب حسمهما قبل التنفيذ
لأنهما يُنتجان KPI مختلفًا:

- **تفسير (أ) — التصنيف هو وحدة المسؤولية:** المورد تفصيلة داخل التصنيف. المسؤول =
  موظف التصنيف. الفائز = مسؤول التصنيف الذي سلّم. **L4 يُهمَل** كوحدة مسؤولية.
- **تفسير (ب) — المورد وحدة مسؤولية مستقلّة:** الفريق مقسّم **بالأخصائيين على الموردين**
  (نفس منطق «الشخص اللي متخصص في مورد معيّن»)، والفائز = **مسؤول المورد** الذي سلّم.
  التصنيف يبقى للعرض/التقارير. هذا يطابق «وكيل/مورد متخصص» الذي ذكره المشغّل في
  محادثات سابقة.

**الاقتراح:** نطبّق **الاثنين معًا** ونُنتج صف فوز لكل مسؤول منصف مع حقل `scope`
(`'category'` أو `'supplier'`)، ثم يُختار أيّهما يُحتسب في KPI بتبديل بسيط — بدل حبس
التصميم في تفسير واحد قبل التأكد. (سؤال 16.9-1.)

### 16.3 L1 — بند طلب العميل (المصدر الحالي للمسؤولية)

**التصنيف المتعدد:** جدول ربط
`customer_rfq_item_categories (customer_rfq_item_id → customer_rfq_items ON DELETE CASCADE, category_id → item_categories, UNIQUE(customer_rfq_item_id, category_id))`.
يبقى `customer_rfq_items.category_id` كـ«التصنيف الأساسي» للعرض والتوافق (لا يُحذف).

**المسؤول:** مفتاح الإسناد يصبح `(customer_rfq_item_id, category_id)`:

- الفهرس المفتوح: `UNIQUE (customer_rfq_item_id, category_id) WHERE valid_to IS NULL`.
- `pickOwner` يعمل **لكل تصنيف على حدة** (من `employee_categories`) ⇒ البند يحصل على
  مسؤول لكل تصنيف. مثال: بند بتصنيفين {أجهزة، قواطع} ⇒ مسؤولان.

**الفائز (حسم):** يُحسم عند **أول تسليم كامل** للبند (A1)، **نهائيًا** (A3). الفائز =
صاحب التصنيف (أو المورد، حسب 16.2) الذي: (1) جاب السعر، (2) جاب PO من العميل،
(3) اتنفّذ (تسليم مسجَّل).

### 16.4 L2 — بند طلب المورد

**التصنيف المتعدد:** `rfq_item_categories (rfq_item_id, category_id)`؛ ويُبقى
`rfq_items.category_id` كأساسي.

**المسؤول:** **يُشتق من L1** — بند المورد المرتبط بـ`customer_rfq_item_id` يقرأ مسؤول
بند العميل لتصنيفه. **لا إسناد مستقل** لبند له أصل عميل (نفس مبدأ الملف الحالي: «المصدر
الوحيد للمسؤولية هو بند العميل»). بند المورد **بلا أصل عميل** (RFQ يدوي) يبقى على
`rfq_item_assignments` القديم — ويُوسَّع بنفس منطق التصنيف المتعدد.

**الفائز:** نفس قاعدة L1 لكن على مستوى بند المورد؛ يُجمَّع لاحقًا إلى بند العميل.

### 16.5 L3 — العرض (offers / offer_items)

**التصنيف المتعدد:** `offer_categories (offer_id → offers ON DELETE CASCADE, category_id)`
— تُشتق آليًا من تصنيفات بنود العرض (`offer_items → rfq_items → rfq_item_categories`).

**المسؤول:** **لا مسؤول مباشر**؛ المسؤول يُشتق من التصنيفات ← إسناد بند العميل (L1).
هذا يحفظ قاعدة «لا تُخترع مسؤولية» — العرض لا يخلق مسؤولًا جديدًا.

**الفائز:** العرض الذي تحوّل إلى أمر شراء **وسُلّم**.

### 16.6 L4 — المورد (المفهوم الجديد)

**التصنيف المتعدد:** `supplier_categories (supplier_id → suppliers ON DELETE CASCADE,
category_id)` — «ما يورّده المورد فعلًا». يُشتق آليًا من العروض/أوامر الشراء، ويقبل
تعديلًا يدويًا.

**مسؤول المورد (الجديد):** جدول `employee_supplier_specialty (employee_id, supplier_id,
is_primary)` — نظير `employee_categories` لكن للمورد. هذا يُجيب سؤال المشغّل مباشرة:
«مين المسؤول عن المورد ده؟». و`employee_categories` يبقى لمسؤولية **التصنيف**.

**الفائز:** إذا اعتُمد تفسير (ب) في 16.2 ⇒ الفائز = مسؤول المورد الذي سلّم.

### 16.7 القاعدة الموحّدة للحسم (خوارزمية واحدة لكل المستويات)

```
تسليم/فاتورة مسجَّلة (A1)
   └─ بند العميل (L1) ── تصنيفاته (L1 ربط)
        ├─ مسؤول كل تصنيف     → صف فوز scope='category'
        └─ مورد البند (L2/L3) → مسؤول المورد (L4) → صف فوز scope='supplier'
```

- **جدول الحسم المقترح:**
  `customer_rfq_item_wins (id, customer_rfq_item_id, employee_id, scope, category_id,
supplier_id, po_item_id, delivered_at, won_at, UNIQUE(customer_rfq_item_id, employee_id, scope))`.
- **الحسم يُكتب مرة واحدة** عند أول اكتمال تنفيذ، ولا يُعاد فتحه (A3). تغيير الاختصاص
  لاحقًا لا يحرّك فائزًا محسومًا.
- **ازدواج:** لو الموظف مسؤول تصنيف **و** مسؤول مورد لنفس البند ⇒ صف فوز **واحد**
  (`scope='supplier'` له الأولوية، أو صف واحد بلا تكرار) — سؤال 16.9-2.

### 16.8 KPI لكل مستوى (ما يُعرض للمشغّل)

| المؤشر                      | المستوى | المعنى                                                   |
| --------------------------- | ------- | -------------------------------------------------------- |
| عدد البنود المسؤول عنها     | L1      | مسؤولية (لكل تصنيف) — لا تُحتسب مرتين لنفس البند/التصنيف |
| بنود جابت عرضًا             | L1      | البنود اللي نزل عليها عرض من مورد                        |
| بنود تحوّلت لـPO            | L1      | فيها أمر شراء من العميل                                  |
| بنود اتنفّذت                | L1      | تسليم مسجَّل (A1)                                        |
| **بنود فازت**               | L1      | فوز محسوم لصاحبها (حسب scope)                            |
| بنود جابت أول PO (معلوماتي) | L1      | مؤشر سرعة استجابة فقط، **لا يُنسب له إنجاز**             |
| عدد الموردين المسؤول عنهم   | L4      | من `employee_supplier_specialty`                         |
| موردون جابوا PO/سلّموا      | L4      | فوز على مستوى المورد (تفسير ب)                           |

**الرصيف (roster) للتغطية:** تقرير يُظهر لكل موظف: تصنيفاته (2+) ومورديه، وأي تصنيف/مورد
**بلا مالك** (A5) — ليراه المدير ويعيّن.

### 16.9 أسئلة مفتوحة (تحتاج قرار المشغّل قبل أي تنفيذ)

1. **تفسير 16.2:** هل المنافسة على **التصنيف** (أ)، أم على **المورد** (ب)، أم **الاثنان**
   (الاقتراح)؟
2. **الازدواج:** لو موظف مسؤول تصنيف ومورد معًا لنفس البند — فوز واحد أم اثنان؟
3. **أول PO:** يُبقى كعمود معلوماتي (الاقتراح) أم يُحذف تمامًا؟
4. **تصنيف بلا مالك:** يبقى البند بلا مسؤول + تنبيه (A5، الاقتراح) أم تعيين إجباري؟
5. **مصدر تصنيف المورد (L4):** آلي من العروض فقط، أم يقبل تعديلًا يدويًا أيضًا؟ (الاقتراح: الاثنان.)
6. **هل يُشتق تصنيف العرض (L3) آليًا فقط**، أم يمكن للمشغّل تصنيف عرض يدويًا؟ (الاقتراح: آلي + تعديل.)

### 16.10 خطة التنفيذ المرحلية (لا تُنفَّذ قبل إقرار 16.9)

- **مرحلة 0 — Preflight (SELECT فقط):** عدد البنود بلا تصنيف، التصنيفات بلا مالك، الموردون
  بلا مسؤول، البنود اللي هتتحول لتصنيف متعدد. (بلا كتابة.)
- **مرحلة 1 — L1 فقط:** جدول ربط التصنيفات + مفتاح الإسناد `(بند، تصنيف)` + `pickOwner`
  لكل تصنيف + تصنيف متعدد من `classifyItem` (يرجّع قائمة مرشحين فوق العتبة بدل الأعلى فقط).
  هذا يُصلح جوهر المشكلة وحدها ويُختبَر قبل التوسّع.
- **مرحلة 2 — الحسم:** جدول `customer_rfq_item_wins` + `resolveItemCompetition` عند التسليم.
- **مرحلة 3 — L2/L3:** جداول ربط التصنيفات للموردين والعروض + الاشتقاق الآلي.
- **مرحلة 4 — L4:** `supplier_categories` + `employee_supplier_specialty` + فوز المورد.
- **مرحلة 5 — KPI + تقرير التغطية** على المستويات المقبولة.

**قواعد الـDDL (ملزمة عند التنفيذ):** كل `CREATE TABLE`/`CREATE INDEX` في **جملة مستقلة**
(الجمل تتشارك معاملة ضمنية — فشل شقيق يرحّل الـCREATE بصمت)، والأهم: **تُوضع الجداول
الجديدة مبكرًا في `init-db.ts` قبل أي migration يعتمد على بيانات** — وهو بالضبط العطل
الذي أُصلح في PR #255 (جداول المسؤوليات لم تُنشأ لأن migration الأرقام فشل قبلها).

### 16.11 اختبارات القبول المقترحة (تُكتب عند التنفيذ، وتفشل قبل الإصلاح)

1. بند بتصنيفين ⇒ إسنادان (مسؤول لكل تصنيف)، وليس إسنادًا واحدًا.
2. بند بتصنيف واحد ⇒ سلوك كما هو (لا انحدار).
3. تصنيف بلا مالك ⇒ البند يبقى بلا مسؤول + يظهر في تقرير التغطية.
4. تسليم مسجَّل ⇒ صف فوز واحد نهائي؛ إعادة التسليم لا تُنشئ فوزًا ثانيًا.
5. تغيير الاختصاص بعد الفوز ⇒ الفائز لا يتحرّك.
6. عرض متعدد التصنيفات ⇒ يظهر تحت كل تصنيفاته، ولا يخلق مسؤولًا جديدًا.
7. مورد له مسؤول (L4) ⇒ يظهر في KPI الموردين.
8. `initDb()` على قاعدة فيها تعارض بيانات ⇒ الجداول الجديدة تُنشأ (حارس PR #255).

---

## 17. تدفّق الإسناد — أين يحدث بالضبط (مناقشة 2026-10-05، الجولة الثالثة — **نُفِّذ في §18**)

> **الحالة:** هذا القسم هو سجلّ التصميم للمناقشة. **التنفيذ الفعلي وقرارات المشغّل في §18.**

### 17.1 ما هو موجود فعليًا الآن (فحص الكود — أدلة)

| #   | الحقيقة                                                                                                | الدليل                                                                |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 1   | **الإسناد الآلي يحدث بالفعل عند إنشاء طلب العميل** — كل بند يُصنَّف ويُسند.                            | `customer-rfq/routes.ts:1493` `ensureCustomerAssignmentsSafe(rfq.id)` |
| 2   | الجدول `customer_rfq_item_assignments` هو **مصدر الحقيقة** للمسؤولية.                                  | `rfq/customer-assignment.ts`                                          |
| 3   | التصنيف **قواعد كلمات مفتاحية** (deterministic) من جدول `item_category_keywords`، بلا استدعاء AI.      | `rfq/classification.ts` (`MIN_CONFIDENCE=40`)                         |
| 4   | الاختصاصات (موظف × تصنيفات + «أساسي») تُدار من **صفحة الموظفين** عبر أيقونة Tags.                      | `users/pages/employees.tsx:656` (`openCats`)                          |
| 5   | **لوحة الإسناد اليدوي** («مسؤولية البنود») **مركّبة على صفحة أمر تسعير المورد** `/rfq/:id` — وهذا خطأ. | `rfq/pages/detail.tsx:1051` `<ItemAssignmentsPanel />`                |
| 6   | صفحة طلب العميل `/customer-rfq/:id` **تعرض** المسؤول/التصنيف لكل بند + مودال تجاوز.                    | `customer-rfq/pages/detail.tsx:750-780, 928`                          |

**الخلاصة:** الطلب (الإسناد الآلي عند الاستلام) **منفَّذ**. المشكلة أن **مكان** التعديل
اليدوي غلط (صفحة RFQ المورد)، والاختصاصات مُخبّأة خلف أيقونة، والتصنيف قواعد لا AI.

### 17.2 الوضع المطلوب (من المشغّل)

```
مدخل البيانات يُدخل طلب العميل  →  /customer-rfq (صفحة الإنشاء)
        │
        ▼  (آلي عند الحفظ — موجود بالفعل)
AI/المحرّك يفهم كل بند ويضعه في التصنيف المناسب
        │
        ▼  (بالاستناد إلى الاختصاصات)
يُسند كل بند لصاحب تصنيفه  →  جدول employee_categories
        │
        ├── للمشاهدة/التجاوز: صفحة طلب العميل /customer-rfq/:id
        └── لضبط مَن يملك كل تصنيف: صفحة الموظفين /employees
```

### 17.3 الفرق عن الوضع الحالي (ما سيُغيَّر فعليًا)

| #   | التغيير                                                                                           | الملف                                       |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| C1  | **حذف** لوحة «مسؤولية البنود» من `/rfq/:id` (أمر تسعير المورد) — لا إسناد من هناك.                | `rfq/pages/detail.tsx:1051` (+ حذف المكوّن) |
| C2  | إبراز عمود «الموظف المسؤول / التصنيف» في `/customer-rfq/:id` + ملخّص بعد الحفظ.                   | `customer-rfq/pages/detail.tsx`             |
| C3  | إظهار المسؤول فور إنشاء الطلب في `/customer-rfq` (ملخّص: «أُسند N بند، M بلا مسؤول»).             | `customer-rfq/pages/new.tsx`                |
| C4  | جعل محرّر الاختصاصات في `/employees` ظاهرًا: عمود «التصنيفات» + زر نصّي، لا أيقونة فقط.           | `users/pages/employees.tsx`                 |
| C5  | تنظيف الراوتات القديمة `GET/PATCH /rfq/:id/assignments*` بعد إزالة الواجهة (تحقق من عدم استخدام). | `rfq/assignments.ts`, `rfq/index.ts`        |

**لا يُحذف:** جدول `rfq_item_assignments` ومسار `ensureAssignmentsForRfq` (لـRFQ المورد
اليدوي بلا أصل عميل) — يبقيان لكن بلا واجهة تعديل يدوي على صفحة المورد.

### 17.4 القرار المطلوب — معنى «الـAI يفهم كل بند»

- **آ (المقترح):** نبقى على المصنّف القواعدي (كلمات مفتاحية) ونوسّع مفرداته من الواجهة.
  **مجاني، فوري، قابل للشرح، وقابل للاختبار** — ونتيجته متوقّعة. البنود منخفضة الثقة
  تظهر «بانتظار المراجعة» ليعيّنها المشغّل.
- **ب:** نضيف مسار AI للموديل (مثل مساعد الواتساب) لتصنيف البنود الغامضة فقط.
  **تحذير:** حصة الموديل اليومية محدودة (20 طلب/موديل/يوم) وهي بالضبط نقطة الفشل
  المسجّلة لهذا المساعد — استخدامها في تصنيف كل بند يستهلك اليوم كله.

**الاقتراح المخفّف:** قواعد أولًا، وإن رجع «غير مصنّف» نستدعي AI **بسقف صغير** (مثلاً
10 بنود/طلب كحد أقصى) كـfallback، مع تخزين النتيجة. (سؤال 17.5-1.)

### 17.5 أسئلة مفتوحة (تحتاج قرار المشغّل قبل التنفيذ)

1. **المصنّف:** قواعد فقط (آ) أم قواعد + AI كـfallback بسقف (المقترح المخفّف)؟
2. **عند بند بلا تصنيف راجح:** يبقى «بلا مسؤول» + تنبيه (A5) أم نُجبر التعيين قبل الحفظ؟
3. **الاختصاصات:** هل تبقى من `/employees` فقط، أم تريد أيضًا اختصارًا من صفحة
   «تصنيفات البنود» (`/item-categories`) لتوزيع الموظفين على التصنيف بسرعة؟
4. **الإشعار:** عند إسناد بند لموظف — هل نُشعره (واتساب/إشعار داخلي) أم يكفي ظهوره في
   صفحة الطلب؟

---

## 18. قرارات المشغّل والتنفيذ (2026-10-05 — **نُفِّذ**)

> **الحالة:** نُفِّذ. يحسم هذا القسم الأسئلة المفتوحة في §17.5 ويصف ما شُحن فعلًا.

### 18.1 قرارات المشغّل (تُحسم §17.5)

| السؤال (§17.5)        | القرار                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| 1. المصنّف            | **AI كامل أولًا** (اختيار ب)، ثم القواعد كـ**fallback** فقط.                    |
| 2. بند بلا تصنيف راجح | **«بلا مسؤول» + تنبيه** — لا إجبار على التعيين قبل الحفظ.                       |
| 3. الاختصاصات         | من **صفحة الموظفين `/employees` فقط** (لا اختصار من `/item-categories`).        |
| 4. الإشعار            | **لا إشعارات** — ظهور المسؤول في صفحة الطلب يكفي.                               |
| — الحصة               | **لا سقف للطلبات**: DEEPSEEK **API مدفوع**، فلا حصة يومية (عكس Gemini المجاني). |

**ملاحظة مهمة:** القيد في §17.4-ب (حصة 20/موديل/يوم) كان خاصًا بموديل Gemini المجاني.
بعد التحوّل إلى **DeepSeek المدفوع** سقط هذا القيد تمامًا، ولذلك اختير «AI كامل» لا
«AI بسقف صغير». المصنّف يستدعي الموديل لـ**كل** بند بلا تصنيف في **طلب واحد مجمّع**.

### 18.2 ما نُفِّذ (بالملفات)

| #   | التغيير                                                                                                      | الملف                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| I1  | **وحدة مصنّف AI** جديدة: تصنيف مجمّع، JSON مغلق من كتالوج التصنيفات، «غير معروف» صريحة.                      | `rfq/ai-classifier.ts` (جديد)                                            |
| I2  | **AI أولًا ثم القواعد** داخل محرّك الإسناد؛ منحى بلا تصنيف أو ثقة < `MIN_CONFIDENCE` → قواعد.                | `rfq/customer-assignment.ts`                                             |
| I3  | **حذف** لوحة «مسؤولية البنود» من `/rfq/:id` + حذف المكوّن بالكامل.                                           | `rfq/pages/detail.tsx`, `rfq/components/ItemAssignmentsPanel.tsx` (حُذف) |
| I4  | **ملخّص المسؤولية** في `/customer-rfq/:id`: «أُسند N من M» + تنبيه «بلا مسؤول/غير مصنّف» + زر إعادة الإسناد. | `customer-rfq/pages/detail.tsx`                                          |
| I5  | **عمود «تصنيفات البنود المسؤول عنها»** في `/employees` + زر «تعديل» نصّي ظاهر.                               | `users/pages/employees.tsx`                                              |
| I6  | **راوت تجميعي** `GET /employees/categories` (كل الموظفين في طلب واحد — لا N+1).                              | `rfq/item-categories.ts`                                                 |

**لم يُحذف:** جدول `rfq_item_assignments` ومسار `ensureAssignmentsForRfq` (لـRFQ المورد
اليدوي بلا أصل عميل) — يبقيان كما في §17.3.

### 18.3 مصمّم المصنّف (قواعد عدم الفشل)

- **طلب واحد مجمّع** لكل الطلب: N بند = استدعاء واحد لا N. `temperature=0`, `toolChoice:"none"`.
- **كتالوج مغلق**: الموديل يختار من `code` الموجود فقط؛ أي كود مُختلق يُرفض.
- **«غير معروف» مسموحة**: عند الشك يبقى البند بلا تصنيف (لا نُنشئ مسؤولية وهمية).
- **Best-effort دائمًا**: مفتاح ناقص/خطأ مزوّد/رد غير قابل للتحليل → `null` → القواعد.
  **لا يجوز أن يُفشل التصنيف إنشاء طلب العميل** (`ensureCustomerAssignmentsSafe`).
- **بوّابة `isAiConfigured`**: بلا مزوّد نعود فورًا بلا أي محاولة شبكة (وتُحفظ الاختبارات
  من لمس الشبكة).

### 18.4 سؤال 17.5-2 (إجبار التعيين) — مُغلق

البند بلا تصنيف راجح **يبقى «بلا مسؤول»** ويظهر **تنبيه** في ملخّص صفحة الطلب. لا
إجبار على التعيين قبل الحفظ: مدخل البيانات قد لا يعرف التصنيف، ومنعُه من الحفظ يوقف
العمل. الإسناد الآلي يُعاد تشغيله لاحقًا بزر «إعادة الإسناد الآلي».

## 19. KPI بالمسؤولية الحقيقية «من أحضر السعر الفائز» (مناقشة 2026-10-05، الجولة الرابعة — **تصميم فقط، لم يُنفَّذ**)

> **الحالة:** تصميم مقترح للمناقشة. **لا يُنفَّذ أي تعديل قبل إقرار القسم كاملًا.**
> يحسم هذا القسم أسئلة §16.9 و§17.5 ويُصحّح فهم «الـKPI» الحالي.

### 19.1 قرارات المشغّل (نصًّا)

| #   | السؤال                                | القرار                                                                                                                            |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | من يُحتسب له البند؟                   | **من أحضر السعر، وصدر أمر شراء على أساسه** — أي `offer.employee_id` للسعر الذي أُسِّس عليه الـPO.                                 |
| 2   | بند بأكثر من تصنيف                    | **يُنسب للمسؤولَين الاثنين** (مسؤولية/تغطية)، لكن **يُحتسب في الـKPI لواحد فقط**: من أحضر السعر الذي أصدر العميل الـPO على أساسه. |
| 3   | هل نُنشئ ربط مورد↔تصنيف (لتقسيم آلي)؟ | **لا** — لا ربط جديد الآن.                                                                                                        |
| 4   | معادلة الـKPI                         | **لا توجد معادلة** — الاحتساب حَدَثي (event): بند مُثبَّت لموظف، لا صيغة مركّبة.                                                  |
| 5   | مكان إسناد التصنيفات للموظفين         | **صفحة الموظفين `/employees` فقط** (يُثبَّت §18.1-3؛ يُلغى المدخل المكرّر).                                                       |

### 19.2 الفرق الجوهري عن الوضع الحالي (أدلة من الكود — فحص فعلي)

| الجانب                     | الوضع الحالي (الكود)                                                                                    | المطلوب (قرار المشغّل)                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| من يُسجَّل كصاحب السعر     | `offers.employee_id` **يُترك NULL** عند إدخال عرض المورد (`rfq/pricing.ts` سطر ~226: الإدراج لا يضبطه). | يُملأ بـ**مَن أحضر السعر فعلًا** لحظة الإدخال.     |
| تثبيت الإنجاز              | `freezeAttributionForItem` يثبّت **مسؤول البند** (صاحب التصنيف)، لا صاحب السعر.                         | يثبّت **صاحب السعر الفائز**.                       |
| أثر التصنيف المتعدد        | لكل بند **مسؤول واحد** (فهرس فريد على الفترة المفتوحة `customer_rfq_item_assignments_open_uq`).         | **مسؤولان** للمسؤولية/التغطية، مع احتساب واحد فقط. |
| تقسيم الموردين حسب التصنيف | غير مطبّق (لا ربط مورد↔تصنيف).                                                                          | **غير مطلوب** (§19.1-3).                           |

**الخلاصة:** الشرط الحقيقي للـKPI الجديد هو **التقاط `offer.employee_id`** + **ربط أمر شراء العميل بالعرض/المورد الذي على أساسه صدر**. اليوم لا الرابط موجود ولا الموظف مُسجَّل.

### 19.3 كيف نعرف «أي سعر أسَّس عليه العميل الـPO»؟ (تحليل المسارات)

- **أمر شراء المورد** (`purchase_orders`) يعرف المورد: `purchase_order_items.supplier_id`. فسعر «من أحضر السعر» يمكن اشتقاقه من `offer_items` لهذا المورد على بند طلب المورد، ثم `offers.employee_id`.
- **أمر شراء العميل** (`customer_po_items`) **لا يحمل `supplier_id`** حاليًا. الرابط الوحيد المتاح: `customerRfqItemId` ← بند طلب المورد (`rfq_items.customerRfqItemId`) ← `offer_items` ← `offers` (المورد + الموظف). لكن هذا قد يعطي **أكثر من عرض** لبند واحد (كل مورد قدّم سعرًا).
- **إشارة حاسمة موجودة:** `offer_items.is_approved` — السعر «المعتمد»، وأشار إليه الكود صراحةً كـ«أساس حساب الهامش» (`procurement-tools.ts`). ومنطق 1.06 في تثبيت طلب العميل يستخدم **السعر المعتمد**. فالمرشّح الطبيعي لـ«السعر الذي على أساسه صدر الـPO» هو **العرض المعتمد** (`is_approved = true`) لذلك البند.
- **فجوة يجب حسمها:** هل «السعر الفائز» = **العرض المعتمد** دائمًا، أم = **المورد المرتبط فعليًا بأمر شراء المورد المُصدَر** (قد يختلفان)؟ هذا هو السؤال الحاكم (انظر §19.6-س1).

### 19.4 التصميم المقترح (مبدأ واحد، لا معادلة)

**قاعدة الاحتساب (حَدَث واحد):** يُثبَّت للبند مسؤول إنجاز = `offers.employee_id` للعرض الفائز لحظة إصدار **أول** أمر شراء (عميل أو مورد). يُخزَّن في حقول التثبيت الموجودة أصلًا على `customer_rfq_items` (`attribution_*`).

**المسؤولية المتعددة (قرار 2):**

- **التغطية/المسؤولية:** البند بأكثر من تصنيف يُنسب لكل مسؤولَي التصنيفين — لأغراض «من يتولّاه» و«من نُبلّغه»، **بدون** احتساب KPI.
- **الاحتساب:** لواحد فقط (صاحب السعر الفائز).
- **عائق تقني:** الفهرس الفريد الحالي يسمح بمسؤول **واحد** لكل بند. لذا التغطية المتعددة تحتاج **جدول مسؤولين للبند** (many-to-many) منفصل عن جدول الاحتساب، أو إبقاء الفترة المفتوحة واحدة للـKPI + جدول تغطية مستقل. (مقترح: `customer_rfq_item_owners` للتغطية + إبقاء `attribution_*` للاحتساب.)

**مصدر «من أحضر السعر»:**

1. إلزام التقاط `offers.employee_id` عند إدخال العرض (من ينشئ العرض يدويًا، أو من أُرسل إليه الرابط إن كان موظفًا).
2. عند إصدار أول أمر شراء للبند: حلّ العرض الفائز (المعتمد / مورد أمر شراء المورد) → كتابة `attribution_employee_id`.
3. سجل تدقيق لكل تثبيت (يوجد `item_assignment_audit`؛ يُوسَّع ليحمل سبب التثبيت: أي عرض/مورد).

**KPI الناتج:** بلا معادلة — تقرير بسيط: `COUNT` البنود المُثبَّتة لكل موظف (بفلتر تاريخ)، مع تفصيل المصدر (تصنيف/سعر/مورد). يُستبعد من العدّ: البنود غير المصنّفة وبلا سعر فائز.

### 19.5 ما هو موجود ويُعاد استخدامه

- `customer_rfq_items.attribution_first_po_at / attribution_employee_id / attribution_employee_name / attribution_event` — حقل التثبيت (يُعاد توجيهه لصاحب السعر).
- `rfq/attribution.ts` — `freezeAttributionForItem` (يُعدَّل مصدر الموظف).
- `item_assignment_audit` — سجل التغييرات.
- `offers.employee_id` — عمود موجود لكنه غير مُلتقَط.
- `offer_items.is_approved` — إشارة السعر المعتمد.
- `customerRfqItemId` على `rfq_items` و`customer_po_items` — لadder الربط الموجود في `shared/po-links.ts`.

### 19.6 أسئلة حاكمة قبل أي تنفيذ (تحتاج قرار المشغّل)

1. **«السعر الفائز» = العرض المعتمد (`is_approved`) أم = مورد أمر الشراء المُصدَر فعليًا؟** (قد يختلفان؛ هذا يحدّد الحل).
2. عند **تعديل** مسؤولية بند بعد التثبيت: يبقى التثبيت كما هو (سلوك اليوم) أم يُعاد؟ (المقترح: يبقى — التاريخ لا يُكتب من جديد).
3. **التغطية المتعددة**: نُنشئ جدول `customer_rfq_item_owners` منفصلًا، أم نكتفي بالتصنيف (بدون مسؤول تغطية ثانٍ)؟
4. **نافذة الـKPI**: من تاريخ التثبيت (`attribution_first_po_at`) أم من تاريخ الطلب؟
5. **مكان إسناد التصنيفات**: تأكيد حذف مدخل «المسؤولون» من `/items` لصالح `/employees` فقط (قرار 5).

### 19.7 خطة التنفيذ المقترحة (لا تُنفَّذ قبل إقرار §19.6)

| مرحلة | العمل                                                                              | ملفات متوقّعة                                              |
| ----- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P0    | إقرار §19.6 (تعريف «السعر الفائز» + التغطية المتعددة).                             | —                                                          |
| P1    | التقاط `offers.employee_id` عند إدخال العرض (مسارات الإدخال كلها).                 | `rfq/pricing.ts`, `rfq/offers.ts`                          |
| P2    | تعديل `freezeAttributionForItem` ليثبّت **صاحب السعر الفائز** بدل مسؤول التصنيف.   | `rfq/attribution.ts`                                       |
| P3    | ربط أمر شراء العميل بالسعر الفائز (المعتمد / مورد أمر الشراء) وإثارته عند الإنشاء. | `customer-po/routes.ts`, `shared/po-links.ts`              |
| P4    | (إن أُقرّ) جدول تغطية متعدد + واجهة إسناد من `/employees` فقط.                     | `lib/db/schema/*`, `users/pages/employees.tsx`             |
| P5    | تقرير KPI حَدَثي (COUNT مثبَّت لكل موظف + تفصيل المصدر).                           | `reports/*`                                                |
| P6    | إظهار التصنيف في «سجل البنود» وصفحة الطلب (رؤية).                                  | `reports/pages/items.tsx`, `customer-rfq/pages/detail.tsx` |

**اختبارات القبول (تُكتب عند التنفيذ وتفشل قبل الإصلاح):** عرض مُدخَل بموظف → يُلتقَط `employee_id`؛ بند بأكثر من تصنيف → تغطية لمسؤولَين؛ إصدار PO على أساس عرض A → يُثبَّت لموظف A لا لصاحب التصنيف؛ تعديل المسؤولية بعد التثبيت → التثبيت لا يتغيّر.

### 19.8 ملاحظة منفصلة — عطل `/rfq/320` (لم يُحقَّق بعد)

بلاغ المشغّل عن `/rfq/320` و`/rfq/321` («Failed» + `CRQ-2026-000273` + «4 غير مصنّف») يخصّ **صفحة طلب المورد**، والعمل كله أعلاه على **طلب العميل**. يُفتح له تحقيق قراءة-فقط منفصل قبل أي إصلاح.

## 20. سجل التنفيذ الفعلي (2026-10-05 — **نُفِّذ**)

> **الحالة:** نُفِّذ بعد إقرار المشغّل «ابدأ في التنفيذ الفعلي». هذا سجل ما شُحن فعلًا
> (ليس خطة)، مع أدلة الاختبارات.

### 20.1 ما شُحن

| المرحلة  | العمل                                                                                                                        | الملفات                                                                          | الحالة |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| P1       | التقاط **مَن أرسل طلب التسعير للمورد** على العرض عند الإدخال وعند المراجعة (`offers.employee_id`).                           | `rfq/pricing.ts`                                                                 | ✅     |
| P2       | `freezeAttributionForItem` يثبّت موظف **العرض المعتمد** (السعر الفائز)، ويسقط لمالك الفترة المفتوحة عند غيابه.               | `rfq/attribution.ts`                                                             | ✅     |
| P3       | إثارة التثبيت عند **إنشاء أمر شراء العميل** (موجود أصلًا في `customer-po/routes.ts`) — أصبح يُثبّت صاحب السعر.               | `customer-po/routes.ts`                                                          | ✅     |
| P5       | تقرير KPI حَدَثي: `GET /analytics/procurement/attributed` — `COUNT` البنود المثبَّتة لكل موظف + تفصيل بالتصنيف + فلتر تاريخ. | `reports/item-kpis.ts`                                                           | ✅     |
| P5 واجهة | بطاقة «مؤشر الأداء» + عمود «بنود مُنسوبة» في **صفحة الموظفين** `/employees` (قرار 5).                                        | `users/pages/employees.tsx`                                                      | ✅     |
| P6       | إظهار **التصنيف** في «سجل البنود والطلبات» (`/items`) — عمود «التصنيف» + فلتر + قيمة «غير مصنّف».                            | `customer-rfq/routes.ts`, `reports/pages/items.tsx`, `lib/api-spec/openapi.yaml` | ✅     |

### 20.2 قرارات حُسمت أثناء التنفيذ

1. **«السعر الفائز» = العرض المعتمد (`offer_items.is_approved`).** هو نفس السعر الذي
   يستخدمه فحص الهامش 1.06 عند تثبيت طلب العميل، فصار مصدر التثبيت متسقًا مع الحساب.
2. **نافذة الـKPI من `attribution_first_po_at`** (لحظة الحدث) لا من تاريخ الطلب.
3. **التثبيت لا يُعاد كتابته** عند تغيّر المسؤولية بعد التثبيت.

### 20.3 القرار المؤجَّل — P4 (التغطية المتعددة)

**لم يُنفَّذ عن قصد.** المشكلة التي أُبلغ عنها هي على **مستوى الطلب** لا البند: الطلب
الواحد يحتوي تصنيفات متعددة (أجهزة/قواطع/كهرباء)، والتصنيف **لكل بند** بالفعل، فالتغطية
المتعددة تعمل أصلًا عبر بنود الطلب المختلفة. تنفيذ «بند واحد بتصنيفين» يحتاج **جدول ربط
many-to-many جديد** (`customer_rfq_item_owners`) + تعديل المصنّف والـAI + واجهة إسناد —
تغيير مخطّط كبير لمشكلة لم تُبلَّغ بعد. أُجّل حتى طلب صريح.

### 20.4 أدلة القبول (TDD)

| الاختبار                      | العدد | يفشل قبل الإصلاح؟                         |
| ----------------------------- | ----- | ----------------------------------------- |
| `offer-attribution.test.ts`   | 3     | ✅ نعم (3/3 فشلت بعد إرجاع المصدر مؤقتًا) |
| `customer-po.test.ts` (تثبيت) | 47    | ✅ 2 منها فشلت قبل الإصلاح                |
| `attributed-kpis.test.ts`     | 4     | ✅ نعم (اختبارات المسار الجديد)           |
| الإجمالي                      | 1434  | كل الاختبارات تمرّ                        |

`tsc` (libs + api-server + portal) نظيف، و`prettier` على كل ملفات ts/tsx نظيف، وبناء
الواجهة نظيف.

### 20.5 ما يتبقّى (اختياري)

- **P4** جدول التغطية المتعددة — عند طلب صريح.
- عطل `/rfq/320` و`/rfq/321` (§19.8) — تحقيق قراءة-فقط منفصل لم يُبدأ بعد.

---

## 21. P4 — التغطية المتعددة (بند بتصنيفين) — **نُفِّذ**

> **الحالة:** نُفِّذ بعد قرار المشغّل الصريح (نموذج متعدد-لمتعدد على مستوى **البند**).
> يُبقي §19.1-2 كما هو: البند يُنسب للمسؤولَين (تغطية) ويُحتسب في الـKPI لواحد فقط.

### 21.1 القرار المُنفَّذ

| #   | القرار                                                                        | التنفيذ                                                                                             |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | بند العميل قد ينتمي **لأكثر من تصنيف** (متعدد-لمتعدد).                        | جدول ربط `customer_rfq_item_categories`؛ يبقى `customer_rfq_items.category_id` تصنيفًا **أساسيًا**. |
| 2   | البند متعدد التصنيفات ⇒ **مسؤول لكل تصنيف** (تغطية) لكن **يُحتسب لواحد فقط**. | الاحتساب كما هو (العرض المعتمد / صاحب السعر) — لا يُمسّ.                                            |
| 3   | لا ربط مورد↔تصنيف (§19.1-3).                                                  | لم يُنشأ أي جدول مورد×تصنيف.                                                                        |

### 21.2 ما شُحن

| #   | التغيير                                                                                                                               | الملف                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| J1  | جدول ربط `customer_rfq_item_categories (customer_rfq_item_id → CASCADE, category_id, employee_id, added_by, UNIQUE(item, category))`. | `lib/db/src/schema/item_categories.ts` + `shared/init-db.ts` (جملة مستقلة) |
| J2  | كل بند في «سجل البنود» يعرض **كل** تصنيفاته (أساسي + إضافي) مع الموظف المسؤول لكل تصنيف.                                              | `customer-rfq/routes.ts` (`SheetCategory[]`, `buildCategories`)            |
| J3  | فلتر عمود «التصنيف» + قيم الفاسِت يطابقان **أي** تصنيف للبند (لا الأساسي فقط).                                                        | `customer-rfq/routes.ts` (`cellValues`, facets)                            |
| J4  | `GET /customer-rfq/items/:id/categories` — أساسي + إضافيات + مسؤول كل تصنيف (قراءة لأي موظف).                                         | `customer-rfq/routes.ts`                                                   |
| J5  | `PUT /customer-rfq/items/:id/categories` — محرّر المدير يستبدل التصنيفات الإضافية ويحلّ مالك كل تصنيف؛ **مدقَّق**.                    | `customer-rfq/routes.ts` (`requireRole("admin","manager")`)                |
| J6  | عمود «التصنيف» في `/items` يعرض شرائح متعددة + زر محرّر (admin/manager).                                                              | `reports/pages/items.tsx`                                                  |

**مبدأ:** التصنيف الأساسي (اختيار المصنّف) يبقى على البند ولا يُكرَّر في جدول الربط؛
الجدول يحمل **الإضافات فقط**، فلا يظهر التصنيف مرتين.

### 21.3 أدلة القبول (TDD)

| الاختبار                                          | العدد | يفشل قبل الإصلاح؟                           |
| ------------------------------------------------- | ----- | ------------------------------------------- |
| `customer-rfq.test.ts` (محرّر التصنيفات المتعددة) | +5    | ✅ مسار جديد (قراءة + استبدال + مالك + 403) |
| الإجمالي                                          | 1440  | كل الاختبارات تمرّ                          |

`tsc --build` + api-server + portal نظيفة؛ `prettier` على كل المستودع نظيف؛ بناء الواجهة نظيف.

---

## 22. تصنيفات البنود — إسناد المسؤول + مطابقة تصنيفات الموردين + قائمة البنود (2026-10-05 — **نُفِّذ**)

> **الحالة:** نُفِّذ بعد قرارات المشغّل الجولة الخامسة. يُكمل §21 (لا يُلغيه).

### 22.1 قرارات المشغّل المُنفَّذة

| #   | القرار                                                                                                                                           | التنفيذ                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| M1  | **المدير** (لا الأدمن فقط) يحدّد مسؤول كل تصنيف — لنفسه أو لأي فرد في الفريق.                                                                    | `requireRole("admin","manager")` على `PUT /item-categories/:id/owners` و`PUT /employees/:id/categories`. |
| M2  | تصنيفات البنود **تطابق** تصنيفات الموردين المعروضة في `/suppliers`.                                                                              | `item_categories` تُبذَر من `supplier_categories` عند البدء، وتُزامَن عند إنشاء/تسمية تصنيف مورد.        |
| M3  | تبويب «تصنيفات البنود» في `/items` يعرض لكل بند: اسم البند، ورقة القطعة/الجزء، Line Item، والتصنيف — **مرئي للجميع، وتحريره admin/manager فقط**. | `GET /customer-rfq/item-categories` + قائمة `ItemsCategoryList` داخل التبويب.                            |

### 22.2 ما شُحن

| #   | التغيير                                                                                                                                                | الملف                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| K1  | إسناد مالك التصنيف صار متاحًا للمدير أيضًا (كان الأدمن فقط) في طبقة الـAPI.                                                                            | `modules/rfq/item-categories.ts`            |
| K2  | بوّابة الواجهة `canSetCatOwners` = admin **أو** manager (المدير يوزّع الاختصاصات).                                                                     | `users/pages/employees.tsx`                 |
| K3  | بذر `item_categories` من تصنيفات الموردين (idempotent بالاسم) عند البدء — نفس قائمة `/suppliers`.                                                      | `shared/init-db.ts`                         |
| K4  | مزامنة إنشاء/تسمية تصنيف المورد إلى `item_categories` (لا إنشاء مزدوج بالاسم).                                                                         | `modules/users/categories.ts`               |
| K5  | `GET /customer-rfq/item-categories` — قائمة البنود مع Line Item/Part No/الوصف/التصنيفات (قراءة لأي موظف)، وفلترة `categoryId` (رقم أو `unclassified`). | `modules/customer-rfq/routes.ts`            |
| K6  | `GET /customer-rfq/item-category-options` — خيارات التصنيف للمحرّر.                                                                                    | `modules/customer-rfq/routes.ts`            |
| K7  | `ItemsCategoryList` داخل تبويب «تصنيفات البنود»: جدول (البند/ورقة القطعة/Line Item/التصنيف) + محرّر التصنيف للمدير فقط.                                | `reports/pages/item-categories.tsx`         |
| K8  | توحيد محرّر تصنيفات البند في `./item-categories` (يستعمله السجل والتبويب) بدل نسختين متفرّقتين.                                                        | `reports/pages/{items,item-categories}.tsx` |

**مبدأ:** مصدر واحد للحقيقة في مكانين — **التصنيف** (بذر/مزامنة من الموردين) و**المحرّر**
(مكوّن واحد). نسختان من نفس الحقيقة تتفرّقان بصمت (نفس صنف عيب `EMAIL_TOOLS` سابقًا).

### 22.3 أدلة القبول (TDD)

| الاختبار                                       | العدد | يفشل قبل الإصلاح؟                                      |
| ---------------------------------------------- | ----- | ------------------------------------------------------ |
| `item-categories.test.ts` (مدير يضبط المالكين) | +3    | ✅ مسار الصلاحية الجديد (manager 200 / purchasing 403) |
| `customer-rfq.test.ts` (قائمة تصنيفات البنود)  | +5    | ✅ مسار جديد (قائمة + فلترة + قراءة data_entry)        |
| الإجمالي                                       | 1448  | كل الاختبارات تمرّ (1448 api-server / 66 portal)       |

`tsc --build` + api-server + portal نظيفة؛ `prettier` على كل المستودع نظيف؛ البناءان نظيفان؛
تحقق دخاني على البناء: `/api/healthz` = 200 و`/api/customer-rfq/item-categories` = 401 (مركّب خلف المصادقة، ليس 404).

---

## 23. محرّر تصنيفات البند — التصحيح الكامل للتصنيف الأساسي (جولة ٢)

> **السياق:** تبويب «تصنيفات البنود» كان يعرض التصنيف **الأساسي** للبند بلا مسؤول
> (`employeeId: null`)، وكان المحرّر **يقفل** التصنيف الأساسي — فيستطيع المدير إضافة
> تصنيفات إضافية فقط، ولا يستطيع **تصحيح** تصنيف خاطئ اختاره المُصنِّف الآلي. هذا
> يجعل «تصحيح التصنيف» — وهو غرض المحرّر أصلًا — غير ممكن.

### 23.1 القرارات

| #   | القرار                                                                                                                                | الطبقة                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| C1  | التصنيف الأساسي يحمل **مسؤول التصنيف** (من `employee_categories`) مثل أي تصنيف إضافي — لا يظهر بلا مسؤول.                             | `GET .../items/:id/categories` |
| C2  | الرد يحمل `primaryCategoryId` صراحةً حتى تعرف الواجهة أيّ تصنيف هو الأساسي (لا تخمين من الترتيب).                                     | `GET .../items/:id/categories` |
| C3  | المدير/الأدمن يستطيع **تحويل التصنيف الأساسي** عبر `primaryCategoryId` — أي تصحيح تصنيف المُصنِّف.                                    | `PUT .../items/:id/categories` |
| C4  | الأساسي **مُلزَم** أن يكون ضمن التصنيفات المختارة؛ وإلا فالأساسي المخزَّن، وإلا أول تصنيف مختار — فلا يشير البند لتصنيف خارج مجموعته. | `PUT .../items/:id/categories` |
| C5  | التصنيف الإضافي يحمل مسؤول التصنيف حتى لو لم يكن للصف `employee_id` صريحًا (احتياطي `employee_categories`).                           | `GET .../items/:id/categories` |

### 23.2 ما شُحن

| #   | التغيير                                                                                   | الملف                               |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| N1  | قراءة مالك التصنيف من `employee_categories` للتصنيف الأساسي أيضًا (كان `null`).           | `modules/customer-rfq/routes.ts`    |
| N2  | الرد يحمل `primaryCategoryId`؛ الواجهة تقرؤه بدل `categories.find(isPrimary)`.            | `routes.ts` + `item-categories.tsx` |
| N3  | `PUT` يقبل `primaryCategoryId` ويحدّث `customer_rfq_items.category_id` داخل نفس المعاملة. | `modules/customer-rfq/routes.ts`    |
| N4  | محرّر الواجهة: زر «تعيين أساسي» لأي تصنيف مختار؛ إلغاء اختيار الأساسي يرقّي تصنيفًا آخر.  | `reports/pages/item-categories.tsx` |

**مبدأ:** التصنيف الأساسي والإضافي **حقيقة واحدة** لكلاهما مالك، ولا فرق بينهما إلا
«أيّهما يوزّع الـKPI». قفل الأساسي كان يجعل المحرّر يقرأ ولا يصحّح.

### 23.3 أدلة القبول (TDD)

| الاختبار                                               | يفشل قبل الإصلاح؟                                     |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `GET` يُعيد `primaryCategoryId` + مالك الأساسي         | ✅ كان `employeeId: null` و`primaryCategoryId` غائبًا |
| المدير يحوّل الأساسي ويُخزَّن على البند                | ✅ لم يكن `primaryCategoryId` مقبولًا أصلًا           |
| الأساسي المطلوب خارج القائمة → ارتداد لأول تصنيف مختار | ✅ مسار جديد                                          |

تحقق حيّ على Postgres حقيقي (بناء `dist`): نقل الأساسي 4→3 خزّن `category_id=3` وأبقى
التصنيف 4 إضافيًا بمالكه؛ موظف `data_entry` نال **403** على `PUT` و**200** على `GET`
(القراءة للجميع، التحرير للمدير/الأدمن). الإجمالي **1450 api-server** اختبارًا يمرّ.

---

## 24. تصنيف آلي على كل الكتالوج + جعل `/items` قراءة فقط (جولة ٣)

> **الحالة:** نُفِّذ. يُكمل §23 ولا يُلغيه.

### 24.1 المشكلة

المصنّف الآلي (`rfq/ai-classifier.ts`) كان **يفلتر التصنيفات على وجود `code`** قبل
عرضها على الموديل. معظم تصنيفات الكتالوج الحقيقية أنشأها المشغّل بلا `code` (مزامنة
تصنيفات الموردين §22-ك2)، فكان الموديل يرى **5 تصنيفات مبذورة فقط** ويعيد «غير معروف»
لكل بند في التصنيفات الأخرى. كما كان محرّر التصنيف متاحًا من تبويب `/items` — وهو
مدخل مكرّر يخالف قرار §19.1-5 («الإسناد من `/employees` فقط»).

### 24.2 ما شُحن

| #   | التغيير                                                                                                                                          | الملف                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| O1  | المصنّف يعرض **كل** تصنيف نشط بالاسم (لا فلترة على `code`)؛ المطابقة بالاسم مع طيّ فروق الهمزة/التاء المربوطة/الياء.                             | `rfq/ai-classifier.ts`                                          |
| O2  | اسم مُختلق من الموديل **يُرفض** (ليس في الكتالوج) — لا تصنيف وهمي.                                                                               | `rfq/ai-classifier.ts`                                          |
| O3  | `POST /customer-rfq/items/classify` — حشو رجعي: تصنيف مجمّع (دفعات 40) لكل بند بلا تصنيف، ثم إسناد مالك كل تصنيف؛ **مدقَّق**، admin/manager فقط. | `modules/customer-rfq/routes.ts` + `rfq/customer-assignment.ts` |
| O4  | زر **«تصنيف آلي»** في رأس `/customer-rfq` (admin/manager) — يشغّل الحشو الرجعي ويعرض «تم التصنيف: N من M».                                       | `customer-rfq/pages/index.tsx`                                  |
| O5  | تبويب **«تصنيفات البنود»** في `/items` صار **قراءة فقط لكل الأدوار**: حُذف `ItemCategoriesEditor` وزرّا التعديل (تبويب التصنيفات + سجل البنود).  | `reports/pages/{item-categories,items}.tsx`                     |
| O6  | `/employees`: عمود الاختصاصات وزر التصنيفات يظهران **لأي فرد** بما فيه admin (كان صف الأدمن يعرض «—»).                                           | `users/pages/employees.tsx`                                     |

**مبدأ:** مصدر واحد للحقيقة. عرض «التصنيف» للجميع (قراءة)، وتحريره من مكان واحد
(`/employees` للإسناد، وصفحة الطلب للتصحيح الفردي) — لا محرّر ثالث في `/items`.
وفلترة الكتالوج على `code` كانت **قدرة تفعل شيئًا غير المُعلَن**: تعرض مجموعة جزئية
وتوهم بالإجابة الكاملة.

### 24.3 أدلة القبول (TDD)

| الاختبار                                              | يفشل قبل الإصلاح؟         |
| ----------------------------------------------------- | ------------------------- |
| `ai-classifier.test.ts` — تصنيف بلا `code` يُقبل      | ✅ كان يُفلتر قبل العرض   |
| `ai-classifier.test.ts` — اسم مُختلق يُرفض            | ✅ مسار جديد              |
| `customer-assignment.test.ts` — حشو رجعي يصنّف ويُسند | ✅ مسار جديد (3 اختبارات) |

`tsc` (libs + api-server + portal) نظيف؛ `prettier` على كل المستودع نظيف؛ البناءان
نظيفان. الإجمالي **1455 api-server + 66 portal** اختبارًا يمرّ.
