# حساب للجوال — Flutter

هذا هو تطبيق الجوال المعتمد. يتصل بخادم API الخاص بالمشروع (Next.js)، والخادم هو الذي يتصل بقاعدة Supabase PostgreSQL باستخدام `DATABASE_URL`. لا يوضع عنوان PostgreSQL أو كلمة مرورها أو مفتاح `service_role` داخل تطبيق الجوال.

## إعداد خادم API

انشر مشروع الويب والخادم على استضافة عامة تدعم Next.js، واربط متغير `DATABASE_URL` في إعدادات الاستضافة بقاعدة Supabase. يجب أن يعمل الخادم على HTTPS وأن يوفّر مسارات `/api/auth/login` و`/api/sync` و`/api/health` وبقية مسارات API للمشروع. المسار `/api/health` عام ويستخدم لفحص الوصول من التطبيق. رابط Supabase مثل `https://<project>.supabase.co` هو خدمة Supabase، وليس عنوان API لهذا التطبيق.

## تشغيل التطوير

في شاشة الدخول يمكن ضبط رابط API يدويًا. للجهاز الفعلي استخدم HTTPS أو عنوان LAN متاحًا أثناء التطوير. لا يعتمد التطبيق على ADB reverse. إذا لم يُضبط عنوان صالح، يبقى حقل رابط API ظاهرًا ويشرح التطبيق سبب تعذر الدخول.

```powershell
cd mobile/flutter_app
flutter pub get
flutter run --dart-define=API_BASE_URL=https://api.example.com
```

استبدل المثال بعنوان API المنشور الفعلي. لا تستخدم `localhost` أو `127.0.0.1` لعناوين توزيع العملاء.

## بناء الإنتاج للأندرويد

يتطلب بناء الحزمة النهائية رابط API عامًا عبر HTTPS ومفتاح توقيع إنتاج محفوظ خارج المستودع. عيّن المتغيرات التالية في بيئة البناء، ثم شغّل السكربت:

- `HISAB_API_BASE_URL`
- `ANDROID_KEYSTORE_PATH`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- optional `HISAB_OFFLINE_AUTH_POLICY`: `cached-credentials` (default), `cached-session`, or `require-online`

```powershell
$env:HISAB_API_BASE_URL = 'https://api.example.com'
$env:HISAB_OFFLINE_AUTH_POLICY = 'cached-credentials'
.\build-production.ps1
```

ينتج Android App Bundle في `build/app/outputs/bundle/release/app-release.aab`. يرفض السكربت رابط localhost أو LAN ويفشل إذا لم يُضبط توقيع الإنتاج. لا تستخدم APK الموقع بمفتاح debug كتطبيق موزع.

## الدخول والعمل دون اتصال

أول تسجيل دخول يتطلب اتصالًا بخادم API. بعد نجاحه يحفظ التطبيق الجلسة في Secure Storage ويحفظ مُتحقِّق PBKDF2-HMAC-SHA256 لكلمة المرور (وليس كلمة المرور نفسها) للسماح بتسجيل الدخول دون اتصال. الجلسة المحفوظة تُفتح تلقائيًا دون اتصال لمدة `OFFLINE_SESSION_DAYS` (30 يوماً افتراضيًا)، ويمكن الدخول بكلمة المرور المحفوظة لمدة `OFFLINE_CREDENTIAL_DAYS` (90 يوماً افتراضياً). تسجيل الخروج يحذف الجلسة والبيانات المحلية للدخول، لذلك يتطلب الدخول التالي اتصالًا.

يمكن ضبط السياسة عند البناء:

```powershell
flutter build apk --release `
  --dart-define=API_BASE_URL=https://api.example.com `
  --dart-define=OFFLINE_AUTH_POLICY=cached-credentials `
  --dart-define=OFFLINE_SESSION_DAYS=30 `
  --dart-define=OFFLINE_CREDENTIAL_DAYS=90 `
  --dart-define=ALLOW_SERVER_OVERRIDE=false
```

القيم المدعومة لـ `OFFLINE_AUTH_POLICY`: `cached-credentials` (الافتراضي)، `cached-session`، و`require-online`. عند `require-online` لا يُسمح بالعمل دون اتصال إطلاقاً. `ALLOW_SERVER_OVERRIDE=false` يقفل رابط الخادم على القيمة المدمجة في نسخة الإنتاج.

بعد المصادقة، يحفظ SQLite أقسام البيانات المسموح بها والكتالوج وبيانات النماذج. العمليات المدعومة تحفظ في outbox SQLite وتُزامن عبر `/api/sync` عند عودة الاتصال، أثناء تشغيل التطبيق أو عند فتحه. يُخصم بيع offline من نسخة المخزون المحلية، ثم يعاد التحقق الذري من الرصيد على الخادم وقت المزامنة. قد تُرفض العملية إذا تغيّر المخزون على جهاز آخر. لكل تثبيت معرف جهاز فريد يُرسل مع عمليات المزامنة بدلاً من معرف مشترك.

إعدادات النشاط وإدارة المستخدمين والمساعد الذكي تتطلب اتصالًا بالخادم. هذا البناء لا يحوّل PostgreSQL إلى قاعدة محلية مشتركة؛ SQLite على كل جهاز، والخادم وSupabase هما نقطة المزامنة المركزية.

## النسخ والاستعادة

من الإعدادات يمكن تصدير نسخة الجهاز (SQLite cache وطابور العمليات) أو تنزيل نسخة الخادم واستعادتها وفق صلاحيات الحساب. لا تغيّر إعداد API أو نسخة التطبيق جداول SQLite الموجودة، ولا تحذف البيانات المحلية.
