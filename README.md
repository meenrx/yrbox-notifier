# yrbox-notifier

ตัวส่งแจ้งเตือนของระบบกล่องยาฉุกเฉิน **รพ.ยะรัง** (yrbox1.web.app / Firebase `yrbox1-11c12`)

โปรเจกต์ Firebase อยู่บนแพลนฟรี (Spark) → **Cloud Functions รันไม่ได้** และต่อเน็ตออกไป `api.line.me` / `api.telegram.org` ไม่ได้
repo นี้จึงทำหน้าที่แทน โดยรันบน **GitHub Actions ทุก 5 นาที** ใช้ `firebase-admin` อ่าน/เขียน Firestore แล้วยิง LINE / Telegram

## ทำอะไรบ้าง (ทุกรอบ)
1. **alerts_outbox (pending)** → ส่ง LINE: ขอแลกกล่อง / ขอตรวจสอบ / อุบัติการณ์ / แนะนำระบบ / **ทดสอบ** แล้ว mark `sent`
2. **audit_logs ใหม่** (action สำคัญ: แลก/จ่าย/คืน/สร้าง/ลบ กล่อง) → Telegram admin
3. **งานรายวัน** (ถึงเวลา `notif_config.dailyNotifyTime`, กันซ้ำวันละครั้ง): recompute ทุกกล่อง → เตือนยาใกล้หมดอายุ (LINE รายแผนก) → แจ้งซ้ำแลกกล่อง → สรุปกล่องค้างตรวจ (Telegram)

token LINE/Telegram อ่านจาก Firestore `notif_config/main` (ตั้งค่าจากหน้า "ตั้งค่า" ในแอป) — ไม่ต้องเก็บซ้ำในนี้

## 🆕 Telegram fallback รายแผนก
ถ้าแผนกไหนตั้ง **Telegram Chat ID** ไว้ (หน้า *แผนก / กลุ่ม LINE* → แก้ไขแผนก) เมื่อ **LINE push ล้มเหลว** ระบบจะส่งข้อความเดียวกันเข้า Telegram แชตนั้นแทนอัตโนมัติ (ใช้ Bot Token ตัวกลางจากหน้า ตั้งค่า) — ครอบคลุมทั้งการแจ้งแบบ event (แลก/ตรวจสอบ/ทดสอบ) และงานรายวัน (เตือนหมดอายุ + แจ้งซ้ำแลก)
สถานะใน `alerts_outbox`: ส่ง LINE สำเร็จ = `sent` · fallback Telegram สำเร็จ = `sent` + `sentVia: telegram_fallback` · ล้มเหลวทั้งคู่ = `failed` + `error: line_and_telegram_failed`

## ตั้งค่า (ครั้งเดียว)
ต้องมี GitHub Secret ชื่อ **`FIREBASE_SA`** = เนื้อ JSON ของ service account key ของ **yrbox1-11c12**:
1. Firebase Console → ⚙️ Project settings → **Service accounts** → **Generate new private key** → ได้ไฟล์ `.json`
2. `gh secret set FIREBASE_SA < path/to/yrbox1-11c12-firebase-adminsdk-xxxx.json`
   (หรือวางเนื้อไฟล์ในหน้า repo → Settings → Secrets and variables → Actions)

> ⚠️ repo ควรเป็น **public** เพื่อให้ GitHub Actions ฟรีไม่จำกัดนาที — secret ถูกเข้ารหัสและ mask ใน log เสมอ · ไม่มี PII คนไข้อยู่ในระบบ

## รันเอง / ทดสอบ
- แท็บ **Actions** → workflow **notify** → **Run workflow** (กดยิงรอบทันที ไม่ต้องรอ 5 นาที)
- หรือ local: `FIREBASE_SA="$(cat yrbox1-11c12-firebase-adminsdk-xxxx.json)" node index.js`

## หมายเหตุ
- ถ้าเปิด billing (Blaze) แล้วกลับไปใช้ Cloud Functions ควร **ปิด/ลบ workflow นี้** เพื่อกันส่งซ้ำ
- โค้ด/logic ตรงกับ `functions/src/index.ts` ของ yrbox ทุกประการ (พอร์ตจาก ygbox-notifier)
