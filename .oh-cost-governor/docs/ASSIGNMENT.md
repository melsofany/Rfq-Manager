# توزيع النماذج المعتمد (2026-11-12)

التوزيع الذي طلبه المشغّل، ومطبَّق فعليًا على OpenHands.

## الجدول

| نوع المهمة           | النموذج                         | البروفايل | المستوى | الموافقة |
| -------------------- | ------------------------------- | --------- | ------- | -------- |
| **بسيطة**            | `openhands/deepseek-v4.1-flash` | Default   | اقتصادي | لا       |
| **متوسطة**           | `gemini/gemini-3.5-flash`       | Gemini    | اقتصادي | لا       |
| **معقّدة**           | `anthropic/claude-opus-5-5`     | Opus 5.5  | premium | **نعم**  |
| التصنيف (classifier) | `groq/openai/gpt-oss-120b`      | Groq      | مجاني   | لا       |

## الأسعار (لكل مليون توكن)

| النموذج             | Input | Output | Cache read |
| ------------------- | ----- | ------ | ---------- |
| deepseek-v4.1-flash | $0.03 | $0.50  | $0.01      |
| gemini-3.5-flash    | $1.50 | $9.00  | $0.15      |
| claude-opus-5-5     | $4.00 | $20.00 | $0.20      |

## النموذج الأساسي

`openhands/deepseek-v4.1-flash` — هذا هو الافتراضي في OpenHands.
المهام البسيطة تُنفَّذ به مباشرة، والتبديل الذاتي يرفعها للمتوسط أو المعقّد
حسب التصنيف.

## أين طُبِّق

| الطبقة              | الموقع                                          | الحالة |
| ------------------- | ----------------------------------------------- | ------ |
| البروفايلات (دائمة) | `POST /api/organizations/{org}/profiles/{name}` | ✅     |
| النموذج الأساسي     | agent-server `/api/settings`                    | ✅     |
| موجّه التصنيف       | meta-profile `cost-router` (مُفعَّل)            | ✅     |
| أداة التبديل        | `enable_classify_and_switch_llm_tool = true`    | ✅     |
| سقف المهمة          | `max_budget_per_task = 1.0`                     | ✅     |

## القاعدة الحاسمة

**Opus 5.5 لا يُستدعى إلا بموافقة صريحة لمرة واحدة.**

```
node src/guard.mjs --model anthropic/claude-opus-5-5          # exit 2 (مرفوض)
node src/guard.mjs --approve --model anthropic/claude-opus-5-5 --ttl-min 30
```

المهام الخلفية (Planner / Condenser / Sub-agents) **ممنوعة** من استخدام
Opus حتى مع وجود موافقة — يُرفض الطلب (exit 2).

## ملاحظة مهمة

حتى مع تفعيل التبديل الذاتي، **التصنيف يحدث داخل الجلسة**. إذا فشل المصنّف
(حد استخدام Groq) تبقى المهمة على النموذج الأساسي (deepseek) — وهذا سلوك آمن،
لا يتصاعد إلى نموذج مدفوع.

## الرجوع

```
node src/rollback.mjs --dry-run
node src/rollback.mjs
```

يُعيد: سقف الميزانية، كل البروفايلات (Gemini → 3.6، إلخ)، ويُلغي الـ meta-profile.
