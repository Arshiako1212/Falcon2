<div align="center">

<img src="banner.svg" alt="Dorm Hub" width="100%">

<img src="typing.svg" alt="features" width="100%">

![Node.js](https://img.shields.io/badge/Node.js-18+-3c873a?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Railway-336791?style=for-the-badge&logo=postgresql&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-010101?style=for-the-badge&logo=socket.io&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-calls-ff5c9a?style=for-the-badge&logo=webrtc&logoColor=white)

<img src="divider.svg" alt="" width="100%">

</div>

<div dir="rtl">

## 🏠 خوابگاه‌یار

وب‌اپ مدیریت هزینه‌های مشترک خوابگاه + گروه + چت + تماس صوتی/تصویری

## ✨ امکانات

- 🔐 ثبت‌نام و ورود با **آیدی + رمز عبور** (بدون پیامک)
- 👥 گروه با کد دعوت؛ سازنده‌ی گروه «مادر خرج» است
- 💸 ثبت هزینه، تعیین سهم هر نفر، «پرداخت کردم» و تأیید/رد توسط مادر خرج
- 🔔 **یادآوری داخل خود برنامه** (اعلان) برای پرداخت‌نشده‌ها: دستی (دکمه 🔔) و خودکار روزانه
- 💬 چت گروهی و خصوصی لحظه‌ای
- 📞 تماس صوتی/تصویری گروهی (مثل کانال صوتی دیسکورد)
- 🖥 **اشتراک صفحه** در تماس: از لپ‌تاپ/کامپیوتر دکمه 🖥 را بزنید؛ همه (حتی روی گوشی) می‌بینند و با ⛶ تمام‌صفحه می‌کنند. مرورگرهای گوشی خودشان اجازه‌ی شروع اشتراک را نمی‌دهند.
- 🛡 پنل مدیر در `/admin`

> ⚠️ مدیر می‌تواند پیام‌ها را ببیند. این موضوع در صفحه‌ی ورود و پروفایل به کاربران نمایش داده می‌شود؛ لطفاً آن را حذف نکنید.

</div>

<div align="center"><img src="divider.svg" alt="" width="100%"></div>

<div dir="rtl">

## 📁 ساختار فایل‌ها

همه‌ی فایل‌ها در یک پوشه (بدون زیرپوشه) هستند تا بشود مستقیم در GitHub آپلود کرد. فایل‌های `banner.svg`، `typing.svg` و `divider.svg` فقط برای انیمیشن همین README هستند.

## 🚀 دیپلوی روی Railway

1. همه‌ی فایل‌ها را در ریشه‌ی یک ریپوی GitHub آپلود کنید (`package.json` باید در ریشه باشد).
2. Railway ← **New Project → Deploy from GitHub repo**.
3. در همان پروژه: **New → Database → Add PostgreSQL**.
4. روی سرویس وب‌اپ ← **Variables**:

| متغیر | مقدار |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | یک رشته‌ی تصادفی بلند |
| `ADMIN_USERNAME` | نام کاربری ادمین |
| `ADMIN_PASSWORD` | رمز قوی ادمین |

5. **Settings → Networking → Generate Domain**. متغیر `PORT` را خودتان نسازید؛ Railway خودش می‌دهد.
6. جدول‌ها در اولین اجرا خودکار ساخته می‌شوند. آدرس سلامت: `/health` و پنل ادمین: `/admin`

اختیاری (برای تماس‌ها): `TURN_URLS`، `TURN_USERNAME`، `TURN_CREDENTIAL`، `STUN_URLS`، `MAX_CALL_PARTICIPANTS`

</div>
