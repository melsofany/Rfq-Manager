# العمليات الميدانية – قرطبة للتوريدات

تطبيق أندرويد للمندوبين الميدانيين، مبني فوق نظام **Cortoba RFQ Manager** القائم.
لا يوجد قاعدة بيانات مستقلة: كل البيانات تُقرأ وتُكتب عبر واجهات `/api/mobile/*`
في نفس خدمة Render (`cortoba-rfq`، `srv-d894ofmq1p3s73fh04vg`).

---

## 1. البنية

```
Rfq-Manager/
├── android/                          تطبيق أندرويد (Kotlin + Compose)
│   └── app/src/main/java/com/cortoba/fieldops/
│       ├── core/network/             Retrofit + DTOs (عقد الأسلاك)
│       ├── core/session/             التوكن مشفَّر (EncryptedSharedPreferences)
│       ├── core/location/            GPS اختياري
│       ├── data/local/               Room: ذاكرة مؤقتة + صندوق صادر
│       ├── data/repository/          مصدر واحد للبيانات
│       ├── data/sync/                محرك المزامنة + WorkManager
│       └── ui/                       الشاشات (Compose + MVVM)
├── artifacts/api-server/src/modules/field-ops/
│   ├── mobile-auth-routes.ts         تسجيل الدخول والخروج وتغيير كلمة المرور
│   ├── mobile-routes.ts              الاستلامات والتسليمات
│   ├── mobile-dashboard-routes.ts    لوحة المعلومات والإشعارات
│   ├── consolidation.ts              تجميع الأصناف مع حفظ التتبع
│   ├── assignment-logic.ts           قواعد الإسناد والصلاحيات والكميات
│   ├── hr-field-assignment-routes.ts إسناد الموظفين من الموارد البشرية
│   └── service.ts                    طبقة قاعدة البيانات
└── lib/db/src/schema/field_operations.ts   جداول العمليات الميدانية
```

---

## 2. قاعدة التجميع – الأهم في المشروع

المندوب يرى **صفاً واحداً** لكل صنف، لكن هذا عرضٌ فقط. الخادم هو من يقرر
التجميع عبر `classificationIdentityKey`، ويرجع `allocations` كاملة.

أولوية المطابقة (في `consolidation.ts`):

1. `itemId` — معرّف الصنف في قاعدة البيانات.
2. `partNo` — رقم قطعة المُصنّع.
3. `brand + model + specs` — بصمة الوصف الفني.
4. `unique` — بند بلا هوية: يبقى مستقلاً ولا يُدمج أبداً.

مثال إلزامي من المتطلبات — كونتاكتور شنايدر `LC1D32M7`:

| الصنف | أمر الشراء للمورد | أمر العميل | الكمية |
|---|---|---|---:|
| LC1D32M7 | SPO-001 | P26E001 | 2 |
| LC1D32M7 | SPO-005 | P26E014 | 3 |
| LC1D32M7 | SPO-009 | P26E021 | 1 |

يظهر للمندوب: **كونتاكتور شنايدر LC1D32M7 — إجمالي 6 قطع**، مع تفصيل قابل
للتوسيع لكل أمر شراء. عند تأكيد الاستلام يُرسل الخادم بنداً لكل `poItemId`
الأصلي — لا يُدمج شيء في قاعدة البيانات.

**لا يُدمج صنفان لتشابه الوصف.** الاختباران
`field-ops-consolidation.test.ts` و `ConsolidationDisplayTest.kt` يقفلان هذا.

---

## 3. مسارات الـ API

### المصادقة

| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/mobile/auth/login` | الرقم الوظيفي + كلمة المرور |
| POST | `/api/mobile/auth/logout` | إنهاء الجلسة |
| POST | `/api/mobile/auth/change-password` | تغيير كلمة المرور |
| POST | `/api/mobile/auth/forgot-password` | إعادة تعيين كلمة المرور |
| GET | `/api/mobile/me` | بيانات الموظف الحالي |

المصادقة بالرقم الوظيفي **مع** كلمة المرور، ولا يُقبل الرقم وحده. يُتحقق من
الموظف في سجلات الموارد البشرية، ويجب أن يكون نشطاً ومُصرّحاً له بالدخول
(`mobileAccessEnabled`). كلمة المرور تُخزَّن مُجزَّأة (bcrypt) على الخادم.

### العمليات

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/mobile/dashboard` | العدّادات والإشعارات |
| GET | `/api/mobile/pickups` | قائمة الاستلامات المُسندة |
| GET | `/api/mobile/pickups/:id` | تفاصيل الاستلام + الأصناف المجمّعة |
| POST | `/api/mobile/pickups/:id/confirm` | تأكيد الاستلام |
| GET | `/api/mobile/deliveries` | قائمة التسليمات |
| GET | `/api/mobile/deliveries/:id` | تفاصيل التسليم |
| POST | `/api/mobile/deliveries/:id/confirm` | تأكيد التسليم |
| GET | `/api/mobile/notifications` | الإشعارات |
| POST | `/api/mobile/sync` | مزامنة صندوق الصادر |

كل مسار يتحقق من ملكية المندوب للمهمة: مندوب لا يرى مهام غيره، ولا يستطيع
تعديل الأسعار أو العروض أو السجلات المالية.

---

## 4. القواعد المُلزَمة على الخادم

القواعد ليست في واجهة الأندرويد — الواجهة تخفي، والخادم يمنع.

| # | القاعدة | التنفيذ |
|---|---|---|
| 1 | الإسناد تلقائي عند اختيار المندوب | `hr-field-assignment-routes.ts` |
| 2 | تجميع مع حفظ التتبع | `consolidation.ts` |
| 3 | تتبع كامل للمورد والعميل | `allocations[]` لكل بند |
| 4 | لا تسليم قبل استلام فعلي | `checkDeliveryQuantities` |
| 5 | لا خلط كميات بين أوامر العملاء | تحقق على مستوى `customerPoId` |
| 6 | سجل تدقيق لكل عملية | `field_operation_events` |
| 7 | لا كتابة فوق السجلات التاريخية | إدراج فقط، لا تحديث |
| 8 | دعم العمليات الجزئية | استلامات وتسليمات متعددة لنفس الأمر |
| 9 | منع التكرار | فهرس فريد على `(employeeId, clientUuid)` |

---

## 5. العمل بدون إنترنت

- المهام المُسندة تُخزَّن في Room للعرض دون اتصال.
- الكميات والملاحظات تُحفظ محلياً في **صندوق الصادر** (`pending_operations`).
- كل عملية تأخذ `clientUuid`، ويُعاد إرسالها بنفس المعرّف — الخادم يعتبرها
  عملية واحدة ولو تكرر الإرسال بسبب انقطاع الشبكة.
- المزامنة تعمل تلقائياً عند عودة الاتصال عبر WorkManager.
- الحالات المعروضة للمندوب: `محفوظ محلياً` / `في انتظار المزامنة` /
  `تمت المزامنة` / `فشلت المزامنة`.
- **لا تُعتبر أي عملية مكتملة إلا بتأكيد الخادم.** رفض الخادم (4xx) لا يُعاد
  المحاولة فيه: يُعرض الخطأ للمندوب بدل استنزاف البطارية.

---

## 6. البناء والتشغيل

### المتطلبات

- JDK 17
- Android SDK 35 (platform + build-tools 35.0.0)
- Gradle 8.11.1

### الأوامر

```bash
cd android

# مفتاح التوقيع (اختياري للإصدار)
export CORT0BA_KEYSTORE=...   # راجع قسم التوقيع أدناه

# نسخة التطوير
gradle :app:assembleDebug

# حزمة النشر
gradle :app:bundleRelease

# الاختبارات
gradle :app:testDebugUnitTest
```

عنوان الخادم قابل للتغيير دون تعديل الكود:

```bash
gradle :app:assembleDebug -PcortobaApiBaseUrl=https://staging.example.com
```

### التكامل المستمر

`.github/workflows/android.yml` يبني APK و AAB ويشغّل الاختبارات عند أي تغيير
تحت `android/`. لا حاجة لرفع الـ wrapper (ملف ثنائي) — الـ workflow يستخدم
`gradle/actions/setup-gradle`.

### التوقيع

`bundleRelease` ينتج AAB **غير موقّع** افتراضياً. للتوقيع أضف إلى
`android/app/build.gradle.kts` كتلة `signingConfigs` تقرأ من متغيرات بيئة
(لا تضع المفاتيح في المستودع)، ثم مرّرها عبر أسرار GitHub.

---

## 7. الاختبارات

| الملف | العدد | يغطي |
|---|---:|---|
| `field-ops-consolidation.test.ts` | 11 | أولوية المطابقة، المثال الإلزامي، عدم دمج المتشابهات |
| `field-ops-logic.test.ts` | 35 | الإسناد، الصلاحيات، حدود الكميات، الجزئي |
| `ConsolidationDisplayTest.kt` | 5 | عرض الإجمالي وتفصيل التوزيع على الأندرويد |

تشغيل اختبارات الخادم:

```bash
pnpm --filter @workspace/api-server run test
```

---

## 8. خارج النطاق

**العهدة المالية** — تظهر في اللوحة بحالة «قريباً». البنية جاهزة للتوسعة، ولا
تُنفَّذ أي حركة مالية في هذه المرحلة.
