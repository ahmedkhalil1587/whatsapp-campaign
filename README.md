# MedConnect Campaigns — دليل التشغيل

تطبيق ويب لإرسال حملات واتساب للأطباء، بدون أي سيرفر أو قاعدة بيانات SQL —
كله شغال بـ HTML/CSS/JS + Google Sheets + Google Apps Script + Meta WhatsApp Cloud API.

هذه أول مرحلة من المشروع وتشمل: **تسجيل الدخول، لوحة التحكم، نظام اللغتين (عربي/إنجليزي)،
والباك إند الأساسي**. باقي الصفحات (الحملات، الأطباء، القوالب، السجل، الإعدادات) هتتبني في المراحل الجاية.

---

## 1. جرّب الواجهة دلوقتي (بدون أي إعداد)

افتح `login.html` في المتصفح مباشرة، وسجّل دخول بالبيانات التجريبية:

- **اسم المستخدم:** `admin`
- **كلمة المرور:** `admin123`

هتلاقي لوحة التحكم شغالة ببيانات تجريبية (Demo Data) عشان تشوف الشكل النهائي قبل ما تربطها بحسابك الحقيقي.

---

## 2. تجهيز Google Sheet (قاعدة البيانات)

1. افتح [sheets.google.com](https://sheets.google.com) واعمل ملف جديد اسمه مثلاً `MedConnect DB`.
2. اعمل 5 شيتات (Tabs) بالأسماء والأعمدة دي بالظبط (الصف الأول = العناوين):

| الشيت | الأعمدة |
|---|---|
| `Doctors` | `ID, Name, Mobile, Specialty, Hospital, City, Country, Status, Notes` |
| `Campaigns` | `ID, Name, Message, ImageUrl, PdfUrl, Status, ScheduledAt, CreatedAt, Sent, Delivered, Read, Failed` |
| `Templates` | `ID, Name, Body` |
| `Logs` | `Timestamp, CampaignID, DoctorID, MobileNumber, WaMessageId, Status` |
| `Users` | `Username, Password, Name, Role` |

3. في شيت `Users` ضيف صف بيانات تسجيل الدخول بتاعك (مثلاً `admin, YourStrongPassword, Admin, admin`).

> ملاحظة: الرقم اللي بتحطه في عمود `Mobile` لازم يكون بصيغة دولية بدون علامة + (مثال: `201001234567`).

---

## 3. نشر الباك إند (Google Apps Script)

1. من داخل الـ Google Sheet: **Extensions > Apps Script**.
2. امسح أي كود موجود، والصق محتوى ملف `backend/Code.gs` اللي جوه المشروع.
3. احفظ (Ctrl+S) وسمّي المشروع أي اسم.
4. من **Project Settings** (الترس ⚙️) تأكد إن **Script Properties** فاضية دلوقتي — هنملاها في الخطوة 5.
5. اضغط **Deploy > New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. اضغط **Deploy**، وهيديك رابط زي:
   `https://script.google.com/macros/s/XXXXXXXXXXXX/exec`
   ده الرابط اللي هتحطه لاحقًا في صفحة الإعدادات بالتطبيق (`mc_gas_url`).

---

## 4. عمل حساب Meta WhatsApp Business API (خطوة بخطوة)

ده الجزء اللي غالبًا محتاج توضيح، وهنعمله سوا خطوة خطوة:

### أ) إنشاء حساب مطوّر على Meta

1. ادخل [developers.facebook.com](https://developers.facebook.com) وسجّل دخول بحساب فيسبوك عادي (يفضل يكون حساب بيزنس).
2. اضغط **My Apps > Create App**.
3. اختار نوع التطبيق **Business**.
4. اكتب اسم التطبيق (مثلاً `MedConnect Campaigns`) واختار حساب البيزنس بتاعك (لو مفيش، هيطلب منك تعمل واحد على [business.facebook.com](https://business.facebook.com)).

### ب) إضافة منتج WhatsApp

1. جوه التطبيق، من الصفحة الرئيسية دوس **Add Product** واختار **WhatsApp > Set up**.
2. Meta هتديك تلقائيًا:
   - **رقم تجريبي مجاني** (Test Number) تقدر تبعت بيه لحد 5 أرقام موثقة وانت بتجرب.
   - **Phone Number ID** — ده اللي هتحطه في الإعدادات.
   - **WhatsApp Business Account ID** — ده الـ Business ID.
   - **Temporary Access Token** (صالح 24 ساعة بس — مفيد للتجربة السريعة).

### ج) عمل Access Token دائم (Permanent Token)

التوكن المؤقت بينتهي كل 24 ساعة، فلازم تعمل توكن دائم:

1. روح [business.facebook.com/settings](https://business.facebook.com/settings) > **Users > System Users**.
2. اضغط **Add** واعمل System User جديد بصلاحية **Admin**.
3. اضغط **Add Assets** واربطه بتطبيق الـ WhatsApp اللي عملته، وادّيله صلاحية **Full control**.
4. اضغط **Generate New Token**:
   - اختار التطبيق بتاعك.
   - اختار الصلاحيات: `whatsapp_business_messaging` و `whatsapp_business_management`.
   - مدة الصلاحية: **Never expire** (أو أطول مدة متاحة).
5. انسخ التوكن ده فورًا (مش هيظهر تاني) واحفظه في مكان آمن.

### د) توثيق رقم واتساب حقيقي للإرسال الفعلي

الرقم التجريبي بيشتغل بس مع أرقام معدودة موثقة يدويًا. عشان تبعت لعدد كبير من الأطباء لازم:

1. من نفس صفحة WhatsApp في تطبيقك، اضغط **Add phone number** وسجّل رقم واتساب بيزنس حقيقي (لازم يكون رقم مش مسجل بالفعل على واتساب عادي).
2. Meta هتطلب توثيق الشركة (**Business Verification**) — بترفع مستندات الشركة (سجل تجاري، إثبات نشاط... إلخ) وممكن تاخد من يوم لأسبوع.
3. بعد التوثيق، لازم تعمل **Message Templates** معتمدة من Meta لأي رسالة هتبعتها لأول مرة لدكتور (خصوصًا لو أكتر من 24 ساعة من آخر رد منه) — ده شرط أساسي في سياسة واتساب لمنع السبام. القوالب اللي في البرومبت بتاعك (دعوة مؤتمر، تذكير، آخر فرصة، الشهادة جاهزة، شكرًا) لازم تتقدّم للموافقة من Meta واحدة واحدة قبل الاستخدام الفعلي.

### هـ) ربط البيانات بالتطبيق

من صفحة **Settings** في التطبيق (هتتبني في المرحلة الجاية) هتدخل:

- **Phone Number ID**
- **WhatsApp Business Account ID**
- **Access Token** (الدائم)
- **Webhook Verify Token** (أي نص سري انت تختاره، هتحطه هنا وفي خطوة الـ Webhook بتاعة Meta بالظبط زي بعض)

كل البيانات دي بتتخزن في **Script Properties** جوه Google Apps Script، مش في المتصفح، عشان محدش يقدر يسرقها من كود الصفحة.

### و) ربط الـ Webhook (لمعرفة حالة كل رسالة: تم التسليم / تمت القراءة / فشلت)

1. في تطبيق Meta بتاعك: **WhatsApp > Configuration > Webhook**.
2. **Callback URL**: نفس رابط الـ Apps Script Web App بتاع الخطوة 3.
3. **Verify Token**: نفس القيمة اللي هتحطها في `WA_WEBHOOK_VERIFY_TOKEN`.
4. اشترك (Subscribe) في حقل **messages**.

---

## 5. حدود مهمة تعرفها من الأول

- **نافذة الـ 24 ساعة**: تقدر تبعت أي رسالة حرة للدكتور لمدة 24 ساعة بعد آخر رد منه. بعد كده لازم تستخدم Template معتمد من Meta.
- **سرعة الإرسال**: حسابك بيبدأ بحد أقصى ~250 محادثة/يوم ويزيد تلقائيًا كل ما تستخدمه بجودة عالية (Meta بتراقب معدل الشكاوى/الحظر).
- **رفع الصور والـ PDF**: لازم ترفعها مكان عام (Google Drive برابط عام، أو أي CDN) وتدي الرابط في الحملة — الـ Apps Script مش سيرفر ملفات.

---

## 6. هيكل المشروع الحالي

```
login.html              صفحة تسجيل الدخول
dashboard.html           لوحة التحكم بالإحصائيات والرسوم البيانية
assets/css/style.css     نظام التصميم (ألوان، خطوط، RTL، الوضع الداكن)
assets/js/i18n.js        محرك الترجمة (عربي/إنجليزي بدون Reload)
assets/js/app.js         سلوك الواجهة المشترك (Theme, Sidebar, Toasts)
assets/js/api.js         الاتصال بالباك إند (Google Apps Script)
assets/js/auth.js        تسجيل الدخول وحماية الصفحات
assets/js/dashboard.js   منطق لوحة التحكم والرسوم البيانية
assets/lang/en.json      نصوص الواجهة بالإنجليزية
assets/lang/ar.json      نصوص الواجهة بالعربية
backend/Code.gs          الباك إند الكامل (Google Apps Script)
```

## 7. تفعيل صفحة الحملات (خطوة إضافية لمرة واحدة)

صفحة **Campaigns** الجديدة بتحتاج حاجتين بسيطتين في الباك إند:

### أ) عمود جديد في شيت Campaigns
افتح Google Sheet بتاعك، شيت **Campaigns**، وضيف عمود جديد بعد آخر عمود اسمه بالظبط:
```
RecipientIds
```
(ده بيستخدم لما تختار عملاء محددين للحملة بدل "كل العملاء النشطين".)

### ب) تفعيل الحملات المجدولة (Schedule)
عشان الحملات اللي بتجدولها لوقت لاحق تتبعت فعليًا من غير ما تفتح المتصفح، لازم تشغّل Trigger مرة واحدة بس:

1. من نفس الـ Apps Script Editor بتاعك، من القائمة العلوية اختار الفانكشن **`setupScheduleTrigger_`** من القائمة المنسدلة جنب زرار "Run".
2. اضغط **Run** (▶).
3. أول مرة هيطلب منك صلاحيات إضافية (Authorize) — وافق عليها.
4. كده تم — أي حملة تجدولها هتتفحص كل 10 دقايق تلقائيًا وتتبعت في معادها.

بعد الخطوتين دول، ارجع لصفحة **Deploy > Manage deployments** واعمل **New version** عشان يطبّق آخر تحديثات الكود، ولو الرابط اتغيّر حدّثه في صفحة Settings.

## 8. الخطوة الجاية

بعد ما تجهز الـ Sheet والـ Apps Script، المرحلة الجاية هنبني فيها صفحات:
**القوالب (Templates) والسجل (History)** — وكلها هتتوصل تلقائيًا بالباك إند اللي جاهز دلوقتي.
(صفحات Login, Dashboard, Settings, Customers, Campaigns جاهزة وشغالة بالفعل.)
