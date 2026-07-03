/**
 * yrbox-notifier — GitHub Actions replacement for the yrbox (รพ.ยะรัง) Cloud Functions.
 *
 * โปรเจกต์ yrbox1-11c12 อยู่บนแพลนฟรี (Spark) → Cloud Functions รันไม่ได้ + ต่อเน็ตออกนอก
 * (api.line.me / api.telegram.org) ไม่ได้. สคริปต์นี้รันบน GitHub Actions (ทุก 5 นาที)
 * ใช้ firebase-admin (service account) อ่าน/เขียน Firestore แล้วยิง LINE / Telegram แทน.
 *
 * แต่ละรอบทำ 3 อย่าง:
 *   1) processPendingAlerts()  — งานใน alerts_outbox (status=pending): ขอแลก/ตรวจสอบ/อุบัติการณ์/แนะนำระบบ/ทดสอบ → LINE
 *   2) processAuditTelegram()  — audit_logs ใหม่ (action สำคัญ) → Telegram admin
 *   3) runDailyIfDue()         — ถึงเวลาที่ตั้งไว้ (notif_config.dailyNotifyTime) วันละครั้ง:
 *                                recompute ทุกกล่อง → เตือนยาใกล้หมดอายุ (LINE) → แจ้งซ้ำแลกกล่อง → สรุปกล่องค้างตรวจ (Telegram)
 *
 * ค่า token (LINE/Telegram) อ่านจาก Firestore notif_config/main เหมือนเดิม (admin อ่านผ่าน rule ได้)
 * ต้องมี env FIREBASE_SA = เนื้อ JSON ของ service account key (เก็บใน GitHub Secret)
 */
const admin = require('firebase-admin')
const dayjs = require('dayjs')
require('dayjs/locale/th')
dayjs.locale('th')

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://yrbox1.web.app'
const DEFAULT_ADMIN_EMAIL = 'niasmee8@gmail.com'

// ---- init admin ----
if (!process.env.FIREBASE_SA) {
  console.error('FATAL: missing FIREBASE_SA env (service account JSON)')
  process.exit(1)
}
let serviceAccount
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SA)
} catch (e) {
  console.error('FATAL: FIREBASE_SA is not valid JSON', e.message)
  process.exit(1)
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

/** เวลาปัจจุบันแบบ ICT (UTC+7) — runner รันบน UTC จึงบวก 7 ชม. */
function nowICT() {
  return dayjs().add(7, 'hour')
}

const DEFAULT_MSG_VERIFY =
  'รบกวนนำกล่องยาฉุกเฉินมาตรวจสอบที่ห้องยา\nเพื่อให้กล่องยาพร้อมใช้เสมอ — ขอบคุณที่ให้ความร่วมมือค่ะ 🙏'

// ============================================================
// Config
// ============================================================
async function getNotifConfig() {
  try {
    const snap = await db.collection('notif_config').doc('main').get()
    return snap.exists ? snap.data() : {}
  } catch (e) {
    console.error('getNotifConfig failed', e)
    return {}
  }
}

async function getThresholds() {
  try {
    const snap = await db.collection('notif_config').doc('main').get()
    const data = snap.data() || {}
    const crit = typeof data.criticalDays === 'number' && data.criticalDays >= 0 ? data.criticalDays : 7
    const def = typeof data.defaultAlertDaysBefore === 'number' && data.defaultAlertDaysBefore >= 0 ? data.defaultAlertDaysBefore : 30
    return { criticalDays: crit, defaultAlertDaysBefore: def }
  } catch {
    return { criticalDays: 7, defaultAlertDaysBefore: 30 }
  }
}

// ============================================================
// Telegram + failure reporting
// ============================================================
async function sendTelegram(text) {
  const cfg = await getNotifConfig()
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
    if (!res.ok) {
      console.error('Telegram send failed', res.status, await res.text())
      return false
    }
    return true
  } catch (e) {
    console.error('Telegram send exception', e)
    return false
  }
}

/** ส่ง Telegram เข้าแชตที่ระบุ (ใช้ bot token กลางจาก notif_config) — สำหรับ fallback รายแผนก */
async function sendTelegramTo(chatId, text) {
  if (!chatId) return false
  const cfg = await getNotifConfig()
  if (!cfg.telegramBotToken) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
    if (!res.ok) {
      console.error('Telegram (per-dept) send failed', res.status, await res.text())
      return false
    }
    return true
  } catch (e) {
    console.error('Telegram (per-dept) send exception', e)
    return false
  }
}

async function reportFailure(context, detail) {
  const cfg = await getNotifConfig()
  const adminEmail = cfg.adminEmail || DEFAULT_ADMIN_EMAIL
  const ts = FieldValue.serverTimestamp()
  await Promise.allSettled([
    db.collection('notification_failures').add({ context, detail, at: ts }),
    db.collection('mail').add({
      to: adminEmail,
      message: {
        subject: `[RxEbox] ส่งแจ้งเตือนล้มเหลว — ${context}`,
        text: `เกิดข้อผิดพลาดในการส่งแจ้งเตือน\n\nบริบท: ${context}\nรายละเอียด:\n${detail}\n\nเวลา: ${dayjs().format('D MMM YYYY HH:mm')}`,
      },
    }),
    sendTelegram(`🛑 <b>RxEbox: ส่งแจ้งเตือนล้มเหลว</b>\nบริบท: ${context}\n${detail}`),
  ])
}

// ============================================================
// LINE push
// ============================================================
async function pushFlex(token, groupId, altText, contents) {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: 'flex', altText, contents }] }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('LINE push failed', res.status, text)
      await reportFailure('LINE push', `${altText}\nสถานะ=${res.status}\n${text}`)
      return false
    }
    return true
  } catch (e) {
    console.error('LINE push exception', e)
    await reportFailure('LINE push (exception)', `${altText}\n${String(e)}`)
    return false
  }
}

// ============================================================
// Status helpers
// ============================================================
function computeStatus(nearestExpiryDate, alertDaysBefore = 30, criticalDays = 7) {
  if (!nearestExpiryDate) return { status: 'empty', daysRemaining: null }
  const days = dayjs(nearestExpiryDate).startOf('day').diff(dayjs().startOf('day'), 'day')
  let status
  if (days < 0) status = 'expired'
  else if (days <= criticalDays) status = 'critical'
  else if (days <= alertDaysBefore) status = 'warning'
  else status = 'ok'
  return { status, daysRemaining: days }
}

async function recomputeBox(boxId) {
  const boxRef = db.collection('boxes').doc(boxId)
  const boxSnap = await boxRef.get()
  if (!boxSnap.exists) return
  const box = boxSnap.data()
  const thresholds = await getThresholds()
  const alertDays = box.alertDaysBefore ?? thresholds.defaultAlertDaysBefore

  const drugsSnap = await boxRef.collection('drugs').orderBy('expiryDate').get()
  if (drugsSnap.empty) {
    await boxRef.update({
      status: 'empty', nearestExpiryDate: null, nearestExpiryDrug: '',
      daysRemaining: null, drugCount: 0, updatedAt: FieldValue.serverTimestamp(),
    })
    return
  }
  const drugs = drugsSnap.docs.map((d) => d.data())
  drugs.sort((a, b) => ((a.expiryDate && a.expiryDate.toMillis ? a.expiryDate.toMillis() : 0) - (b.expiryDate && b.expiryDate.toMillis ? b.expiryDate.toMillis() : 0)))
  const nearest = drugs[0]
  const nearestDate = nearest.expiryDate && nearest.expiryDate.toDate ? nearest.expiryDate.toDate() : null
  const { status, daysRemaining } = computeStatus(nearestDate, alertDays, thresholds.criticalDays)
  await boxRef.update({
    status, nearestExpiryDate: nearest.expiryDate, nearestExpiryDrug: nearest.name ?? '',
    daysRemaining, drugCount: drugs.length, updatedAt: FieldValue.serverTimestamp(),
  })
}

async function runRecomputeAllBoxes() {
  const snap = await db.collection('boxes').get()
  for (const d of snap.docs) {
    try { await recomputeBox(d.id) } catch (e) { console.error('recompute', d.id, e.message) }
  }
  console.log(`recomputed ${snap.size} boxes`)
}

// ============================================================
// Flex builders (ported from functions/src/index.ts)
// ============================================================
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
}

function nearestDrugLine(boxData) {
  const drug = boxData.nearestExpiryDrug || ''
  if (!drug) return ''
  const exDate = boxData.nearestExpiryDate && boxData.nearestExpiryDate.toDate ? boxData.nearestExpiryDate.toDate() : null
  const days = boxData.daysRemaining
  const expiryStr = exDate ? dayjs(exDate).format('D MMM YYYY') : '-'
  if (days != null) {
    return days < 0
      ? `⏰ ${drug}\nหมดอายุไปแล้ว ${Math.abs(days)} วัน (${expiryStr})`
      : `⏰ ${drug}\nหมดอายุ ${expiryStr} · เหลือ ${days} วัน`
  }
  return `⏰ ${drug} · หมดอายุ ${expiryStr}`
}

function nearestDrugVars(boxData) {
  const exDate = boxData.nearestExpiryDate && boxData.nearestExpiryDate.toDate ? boxData.nearestExpiryDate.toDate() : null
  const days = boxData.daysRemaining
  return {
    drug: boxData.nearestExpiryDrug || '',
    expiry: exDate ? dayjs(exDate).format('D MMM YYYY') : '',
    days: days != null ? String(days) : '',
  }
}

function buildSwapRequestFlex(department, boxNo, requestedByName, boxId, customMsg = '', drugLine = '', drugVars = { drug: '', expiry: '', days: '' }, isHome = false) {
  const headTitle = isHome ? `กรุณานำกล่อง ${boxNo} มาบรรจุที่ห้องยา` : `กรุณานำกล่อง ${boxNo} มาแลก`
  const defaultBody = isHome
    ? `กล่องประจำ: ${boxNo}\nรบกวนนำมาบรรจุ/ตรวจที่ห้องยา แล้วนำกลับไว้ที่เดิม`
    : `แผนก: ${department}\nกล่อง: ${boxNo}\nผู้แจ้ง: ${requestedByName}`
  const bodyText = customMsg ? fillTemplate(customMsg, { boxNo, department, actor: requestedByName, ...drugVars }) : defaultBody
  const showDrugBlock = drugLine && !customMsg.includes('{drug}')
  const bodyContents = [{ type: 'text', text: bodyText, size: 'sm', wrap: true }]
  if (showDrugBlock) {
    bodyContents.push({ type: 'separator', margin: 'md' })
    bodyContents.push({ type: 'text', text: drugLine, size: 'sm', color: '#DC2626', weight: 'bold', wrap: true, margin: 'sm' })
  }
  bodyContents.push({ type: 'separator', margin: 'md' })
  bodyContents.push({ type: 'text', text: `จาก: ${requestedByName}`, size: 'xs', color: '#999999', margin: 'sm' })
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: isHome ? '🏠 แจ้งจากห้องยา' : '🔄 แจ้งจากห้องยา', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: headTitle, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
      ],
      backgroundColor: isHome ? '#7C3AED' : '#EA580C',
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
    footer: {
      type: 'box', layout: 'vertical',
      contents: [{ type: 'button', style: 'primary', color: '#EA580C', action: { type: 'uri', label: 'เปิดข้อมูลกล่อง', uri: `${APP_BASE_URL}/box/${boxId}` } }],
    },
  }
}

function buildVerifyFlex(department, requestedByName, customMsg) {
  const bodyText = fillTemplate(customMsg, { department, actor: requestedByName })
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '📋 ขอตรวจสอบกล่อง', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: `แผนก: ${department}`, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
      ],
      backgroundColor: '#7C3AED',
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: bodyText, size: 'sm', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: `จาก: ${requestedByName}`, size: 'xs', color: '#999999', margin: 'sm' },
      ],
    },
  }
}

function buildIncidentFlex(count, requestedByName) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '🚨 อุบัติการณ์', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: 'หมายเลขกล่องในระบบไม่ตรงกับที่อยู่จริง', weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
      ],
      backgroundColor: '#DC2626',
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: `📊 อุบัติการณ์สะสม: ${count} ครั้ง`, size: 'sm', weight: 'bold', color: '#DC2626' },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: 'กรณีแลกกล่องยาฉุกเฉิน โปรดบันทึกในระบบด้วยทุกครั้ง โดยการสแกนคิวอาร์โค้ด ระบุว่ารับคืนกล่องไหน แล้วแลกเป็นกล่องไหน เพื่อป้องกันความเสี่ยงกล่องยาฉุกเฉินไม่พร้อมใช้', size: 'sm', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: `จาก: ${requestedByName}`, size: 'xs', color: '#999999', margin: 'sm' },
      ],
    },
  }
}

/** Flex ทดสอบระบบ — ปุ่ม "ทดสอบส่ง" รายแผนก */
function buildTestFlex(department, requestedByName) {
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '🔔 ทดสอบระบบแจ้งเตือน', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: department, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
      ],
      backgroundColor: '#059669',
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: '✅ กลุ่มนี้เชื่อมต่อระบบแจ้งเตือนกล่องยาฉุกเฉินเรียบร้อย', size: 'sm', wrap: true },
        { type: 'text', text: 'ข้อความนี้เป็นการทดสอบจากห้องยา ไม่ต้องดำเนินการใดๆ', size: 'xs', color: '#666666', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: `จาก: ${requestedByName} · ${dayjs().add(7, 'hour').format('D MMM YYYY HH:mm')}`, size: 'xs', color: '#999999', margin: 'sm' },
      ],
    },
  }
}

function stepItem(icon, title, detail, titleColor = '#0F172A') {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: 'sm',
    contents: [
      { type: 'text', text: icon, size: 'lg', flex: 0 },
      {
        type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'sm', color: titleColor, wrap: true },
          { type: 'text', text: detail, size: 'xs', color: '#64748B', wrap: true },
        ],
      },
    ],
  }
}

function buildSystemIntroPharmacyFlex(department) {
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: '👔 ระบบกล่องยาฉุกเฉินใหม่', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: 'สำหรับเจ้าหน้าที่ห้องยา', weight: 'bold', size: 'xl', color: '#FFFFFF' },
        { type: 'text', text: department, size: 'xs', color: '#FCE7F3', margin: 'sm' },
      ],
      backgroundColor: '#0891B2', paddingAll: 'lg',
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: 'ขั้นตอนปฏิบัติงาน — แลกกล่อง/บรรจุยาใหม่', size: 'sm', wrap: true, color: '#475569' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '🔄 เมื่อแผนกนำกล่องมาแลก', weight: 'bold', size: 'md', color: '#0F172A', margin: 'sm' },
        stepItem('1️⃣', 'สแกน QR บนกล่องที่แผนกนำมา', 'เปิดหน้ารายละเอียดกล่องในระบบ'),
        stepItem('2️⃣', 'แตะปุ่ม "ขอแลกกล่อง"', 'เลือกกล่องใหม่ที่จะส่งคืนให้แผนก ระบบจะสลับกล่องอัตโนมัติ'),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '📦 บรรจุกล่องเก่า → พร้อมจ่ายใหม่', weight: 'bold', size: 'md', color: '#0F172A', margin: 'sm' },
        stepItem('3️⃣', 'เติมยาเข้ากล่อง', 'ตามรายการมาตรฐาน — ตรวจสอบครบทุกตัว'),
        stepItem('4️⃣', 'สแกน QR กล่องเดิม', 'เปิดหน้ารายการยา'),
        stepItem('5️⃣', 'แตะ "แก้ไข" รายยา', 'อัปเดตจำนวน + วันหมดอายุใหม่'),
        stepItem('6️⃣', 'กด "บันทึก"', 'ระบบ recompute สถานะกล่องอัตโนมัติ'),
        stepItem('7️⃣', 'ล็อกกล่อง เก็บที่ห้องยา', 'พร้อมจ่ายในรอบถัดไป'),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '💡 จุดสำคัญ', weight: 'bold', size: 'sm', color: '#0F172A', margin: 'sm' },
        { type: 'text', text: '• ทุกขั้นตอนถูกบันทึกใน audit log อัตโนมัติ', size: 'xs', color: '#475569', wrap: true },
        { type: 'text', text: '• ตั้ง threshold เตือนใกล้หมดอายุได้ในหน้า ตั้งค่า', size: 'xs', color: '#475569', wrap: true },
        { type: 'text', text: '• ดูประวัติย้อนหลังได้ที่ /logs', size: 'xs', color: '#475569', wrap: true },
      ],
      paddingAll: 'lg',
    },
  }
}

function buildSystemIntroDeptFlex(department) {
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: '🏥 ระบบกล่องยาฉุกเฉินใหม่', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: 'สำหรับเจ้าหน้าที่แผนก', weight: 'bold', size: 'xl', color: '#FFFFFF' },
        { type: 'text', text: department, size: 'xs', color: '#E0F2FE', margin: 'sm' },
      ],
      backgroundColor: '#7C3AED', paddingAll: 'lg',
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: 'ห้องยาจะดูแลให้กล่องยาฉุกเฉินของแผนกพร้อมใช้เสมอ ผ่านการแจ้งเตือนอัตโนมัติทางไลน์กลุ่ม', size: 'sm', wrap: true, color: '#475569' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '🔔 ระบบจะแจ้งเตือนเมื่อไหร่', weight: 'bold', size: 'md', color: '#0F172A', margin: 'sm' },
        stepItem('⏰', 'ยาในกล่องใกล้หมดอายุ', 'ระบบจะส่ง LINE ขอให้รีบนำกล่องมาแลกที่ห้องยา'),
        stepItem('📋', 'กล่องไม่เคลื่อนไหวนาน', 'ห้องยาจะประสานขอให้นำกล่องมาตรวจสอบเป็นระยะ'),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '🙏 ขอความร่วมมือ', weight: 'bold', size: 'md', color: '#0F172A', margin: 'sm' },
        { type: 'text', text: 'เมื่อได้รับแจ้งเตือนในไลน์ รบกวนนำกล่องมาที่ห้องยาตามแจ้ง เพื่อให้กล่องยาพร้อมใช้เมื่อจำเป็น', size: 'sm', color: '#475569', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '📞 พบปัญหา/สอบถาม', weight: 'bold', size: 'sm', color: '#0F172A', margin: 'sm' },
        { type: 'text', text: 'ติดต่อ ห้องยา รพ.ยะรัง', size: 'xs', color: '#64748B', wrap: true },
      ],
      paddingAll: 'lg',
    },
  }
}

function buildExpiryFlex(deptName, rows) {
  function statusColor(s) {
    switch (s) {
      case 'expired': return '#dc2626'
      case 'critical': return '#ea580c'
      case 'warning': return '#ca8a04'
      default: return '#059669'
    }
  }
  function statusLabel(s, days) {
    if (days === null || days === undefined) return '—'
    if (s === 'expired') return `หมดอายุ ${Math.abs(days)} วัน`
    return `เหลือ ${days} วัน`
  }
  return {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '🚨 RxEbox แจ้งเตือนกล่องยา', size: 'sm', color: '#FFFFFF' },
        { type: 'text', text: deptName, weight: 'bold', size: 'xl', color: '#FFFFFF' },
        { type: 'text', text: dayjs().add(7, 'hour').format('D MMM YYYY'), size: 'xs', color: '#FFFFFFAA' },
      ],
      backgroundColor: '#0891b2',
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: rows.length === 0
        ? [{ type: 'text', text: '✅ ไม่มีกล่องยาที่ใกล้หมดอายุ', size: 'md', color: '#666666' }]
        : rows.slice(0, 10).map((r) => ({
          type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm',
          contents: [
            {
              type: 'box', layout: 'horizontal',
              contents: [
                { type: 'text', text: `📦 ${r.boxNo}`, weight: 'bold', size: 'md', flex: 4 },
                { type: 'text', text: statusLabel(r.status, r.daysRemaining), size: 'sm', align: 'end', color: statusColor(r.status), weight: 'bold', flex: 3 },
              ],
            },
            { type: 'text', text: r.nearestExpiryDrug || '-', size: 'sm', color: '#555555', wrap: true },
            { type: 'text', text: `หมดอายุ ${r.nearestExpiryDate ? dayjs(r.nearestExpiryDate).format('D MMM YYYY') : '-'}`, size: 'xs', color: '#999999' },
            { type: 'button', style: 'secondary', height: 'sm', margin: 'sm', color: '#0891b2', action: { type: 'uri', label: `📲 เปิดกล่อง ${r.boxNo}`, uri: `${APP_BASE_URL}/box/${r.id}` } },
            { type: 'separator', margin: 'md' },
          ],
        })),
    },
  }
}

// ============================================================
// 1) Pending alerts (alerts_outbox)  — replaces onAlertOutbox
// ============================================================
async function handleOneAlert(token, docSnap) {
  const data = docSnap.data() || {}
  const department = data.department ?? ''
  const type = data.type ?? 'box_swap_request'
  const boxNo = data.boxNo ?? ''
  const requestedByName = data.requestedByName ?? ''

  // ปลายทาง LINE ของแผนก
  const deptsSnap = await db.collection('departments').where('name', '==', department).limit(1).get()
  if (deptsSnap.empty) {
    await docSnap.ref.update({ status: 'failed', error: 'dept_not_found', processedAt: FieldValue.serverTimestamp() })
    return
  }
  const deptData = deptsSnap.docs[0].data()
  const groupId = deptData.lineGroupId || deptData.lineUserId
  if (!groupId) {
    await docSnap.ref.update({ status: 'failed', error: 'no_line_target', processedAt: FieldValue.serverTimestamp() })
    return
  }

  const cfg = await getNotifConfig()
  let flex
  let altText

  if (type === 'test') {
    flex = buildTestFlex(department, requestedByName || 'ทดสอบระบบ')
    altText = `🔔 ทดสอบระบบแจ้งเตือน — ${department}`
  } else if (type === 'box_verify_unknown') {
    const msg = deptData.msgVerify || cfg.msgVerify || DEFAULT_MSG_VERIFY
    flex = buildVerifyFlex(department, requestedByName, msg)
    altText = `ขอตรวจสอบกล่องของ ${department}`
  } else if (type === 'incident_report') {
    flex = buildIncidentFlex(data.incidentCount ?? 1, requestedByName)
    altText = `อุบัติการณ์: หมายเลขกล่องในระบบไม่ตรงกับจริง (ครั้งที่ ${data.incidentCount ?? 1})`
  } else if (type === 'system_intro') {
    const audience = data.audience === 'pharmacy' ? 'pharmacy' : 'department'
    flex = audience === 'pharmacy' ? buildSystemIntroPharmacyFlex(department) : buildSystemIntroDeptFlex(department)
    altText = audience === 'pharmacy' ? '📖 แนะนำระบบกล่องยาฉุกเฉิน (สำหรับห้องยา)' : '📖 แนะนำระบบกล่องยาฉุกเฉิน (สำหรับแผนก)'
  } else if (type === 'box_verify_request') {
    const msg = deptData.msgVerify || cfg.msgVerify || DEFAULT_MSG_VERIFY
    flex = buildVerifyFlex(department, requestedByName, msg)
    altText = `ขอตรวจสอบกล่องของ ${department}`
  } else {
    // box_swap_request
    let drugLine = ''
    let drugVars = { drug: '', expiry: '', days: '' }
    let isHome = false
    if (data.boxId) {
      const boxSnap = await db.collection('boxes').doc(data.boxId).get()
      if (boxSnap.exists) {
        const bx = boxSnap.data()
        drugLine = nearestDrugLine(bx)
        drugVars = nearestDrugVars(bx)
        isHome = !!(bx.homeDepartment && String(bx.homeDepartment).trim())
      }
    }
    const swapMsg = isHome ? '' : (deptData.msgSwapRequest || cfg.msgSwapRequest || '')
    flex = buildSwapRequestFlex(department, boxNo, requestedByName, data.boxId, swapMsg, drugLine, drugVars, isHome)
    const verb = isHome ? 'มาบรรจุที่ห้องยา' : 'มาแลก'
    altText = drugVars.drug ? `แจ้ง: นำกล่อง ${boxNo} ${verb} (${drugVars.drug} เหลือ ${drugVars.days} วัน)` : `แจ้ง: นำกล่อง ${boxNo} ${verb}`
  }

  const ok = await pushFlex(token, groupId, altText, flex)
  if (ok) {
    await docSnap.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp() })
    return
  }

  // LINE ส่งไม่สำเร็จ → fallback เข้า Telegram รายแผนก (ถ้าตั้ง telegramChatId ไว้)
  const tgChatId = deptData.telegramChatId
  if (tgChatId) {
    const fbText =
      `⚠️ <b>LINE ส่งไม่สำเร็จ — ส่งผ่าน Telegram แทน</b>\n` +
      `🏥 แผนก: <b>${department}</b>\n` +
      altText
    const tgOk = await sendTelegramTo(tgChatId, fbText)
    if (tgOk) {
      await docSnap.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), sentVia: 'telegram_fallback' })
      return
    }
    await docSnap.ref.update({ status: 'failed', error: 'line_and_telegram_failed', processedAt: FieldValue.serverTimestamp() })
    return
  }

  await docSnap.ref.update({ status: 'failed', error: 'line_push_failed', processedAt: FieldValue.serverTimestamp() })
}

async function processPendingAlerts() {
  const snap = await db.collection('alerts_outbox').where('status', '==', 'pending').limit(50).get()
  if (snap.empty) return
  const cfg = await getNotifConfig()
  const token = cfg.lineToken || ''
  if (!token) {
    console.error('LINE token not set — mark pending alerts failed')
    await reportFailure('LINE token ไม่ได้ตั้งค่า', 'ยังไม่ได้ตั้ง LINE Channel Access Token ในหน้าตั้งค่าของระบบ')
    return
  }
  for (const docSnap of snap.docs) {
    try {
      await handleOneAlert(token, docSnap)
    } catch (e) {
      console.error('handleOneAlert error', docSnap.id, e.message)
      await docSnap.ref.update({ status: 'failed', error: String(e.message || e), processedAt: FieldValue.serverTimestamp() }).catch(() => {})
    }
  }
  console.log(`processed ${snap.size} pending alerts`)
}

// ============================================================
// 2) Audit logs → Telegram  — replaces onAuditLog
// ============================================================
const AUDIT_LABEL = {
  box_created: '🆕 สร้างกล่อง', box_updated: '✏️ แก้ไขกล่อง', box_deleted: '🗑️ ลบกล่อง',
  drug_added: '➕ เพิ่มยา', drug_updated: '✏️ แก้ไขยา', drug_removed: '➖ ลบยา',
  box_swap: '🔄 แลกกล่อง', box_deployed: '📤 จ่ายกล่อง', box_returned: '📥 คืนกล่อง',
  box_refilled: '📦 บรรจุยาเสร็จ', box_inspected: '🔍 ตรวจสอบ/แจ้งเตือน',
}
const TELEGRAM_IMPORTANT_ACTIONS = new Set(['box_swap', 'box_deployed', 'box_returned', 'box_created', 'box_deleted'])

async function processAuditTelegram() {
  const stateRef = db.collection('notif_state').doc('main')
  const stateSnap = await stateRef.get()
  const cursor = stateSnap.exists ? stateSnap.data().lastAuditTelegramTs : null

  // ครั้งแรก (ยังไม่มี cursor): ตั้ง cursor = now แล้วข้าม ไม่ย้อนส่ง log เก่าทั้งหมด
  if (!cursor) {
    await stateRef.set({ lastAuditTelegramTs: FieldValue.serverTimestamp() }, { merge: true })
    console.log('audit telegram: init cursor, skip backlog')
    return
  }

  const snap = await db.collection('audit_logs').where('timestamp', '>', cursor).orderBy('timestamp', 'asc').limit(50).get()
  if (snap.empty) return

  let lastTs = cursor
  for (const d of snap.docs) {
    const data = d.data()
    lastTs = data.timestamp || lastTs
    const action = data.action ?? ''
    if (!TELEGRAM_IMPORTANT_ACTIONS.has(action)) continue
    const label = AUDIT_LABEL[action] ?? `🔔 ${action}`
    const text =
      `${label}\n` +
      `📦 กล่อง: <b>${data.boxNo ?? '-'}</b>\n` +
      (data.details ? `📝 ${data.details}\n` : '') +
      `👤 โดย: ${data.userName ?? '-'}\n` +
      `🕒 ${dayjs().add(7, 'hour').format('D MMM YYYY HH:mm')}`
    await sendTelegram(text)
  }
  await stateRef.set({ lastAuditTelegramTs: lastTs }, { merge: true })
  console.log(`audit telegram: processed up to ${snap.size} logs`)
}

// ============================================================
// 3) Daily jobs — replaces dailyNotifications + nightlyRecompute
// ============================================================
async function sendExpiryNotifications(token) {
  const [deptsSnap, boxesSnap] = await Promise.all([
    db.collection('departments').get(),
    db.collection('boxes').get(),
  ])
  const depts = deptsSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const boxes = boxesSnap.docs.map((d) => {
    const x = d.data()
    return {
      id: d.id,
      boxNo: x.boxNo ?? '',
      currentLocation: x.currentLocation ?? x.department ?? '',
      status: x.status ?? 'empty',
      daysRemaining: x.daysRemaining ?? null,
      nearestExpiryDrug: x.nearestExpiryDrug ?? '',
      nearestExpiryDate: x.nearestExpiryDate && x.nearestExpiryDate.toDate ? x.nearestExpiryDate.toDate() : null,
    }
  })

  let pushCount = 0
  for (const dept of depts) {
    const groupId = dept.lineGroupId
    if (!groupId) continue
    const deptName = dept.name
    const myBoxes = boxes
      .filter((b) => b.currentLocation === deptName)
      .filter((b) => b.status === 'warning' || b.status === 'critical' || b.status === 'expired')
      .sort((a, b) => (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999))
    if (myBoxes.length === 0) continue
    const flex = buildExpiryFlex(deptName, myBoxes)
    const ok = await pushFlex(token, groupId, `แจ้งเตือน ${deptName}: ${myBoxes.length} กล่อง`, flex)
    if (ok) {
      pushCount++
    } else if (dept.telegramChatId) {
      // LINE ล้มเหลว → fallback Telegram รายแผนก
      const lines = myBoxes.slice(0, 10).map((b) => {
        const d = b.daysRemaining
        const dl = d == null ? '-' : d < 0 ? `หมดอายุ ${Math.abs(d)} วัน` : `เหลือ ${d} วัน`
        return `• ${b.boxNo} — ${b.nearestExpiryDrug || '-'} (${dl})`
      }).join('\n')
      const fbText =
        `⚠️ <b>LINE ส่งไม่สำเร็จ — ส่งผ่าน Telegram แทน</b>\n` +
        `🏥 แผนก: <b>${deptName}</b>\n` +
        `🚨 กล่องใกล้/หมดอายุ ${myBoxes.length} กล่อง\n${lines}`
      if (await sendTelegramTo(dept.telegramChatId, fbText)) pushCount++
    }
  }
  return pushCount
}

async function runSwapAlertReminder(token) {
  const snap = await db.collection('boxes').where('swapAlertActive', '==', true).get()
  if (snap.empty) return
  const cfg = await getNotifConfig()
  const deptsSnap = await db.collection('departments').get()
  const deptMap = new Map()
  const deptMsgMap = new Map()
  const deptTgMap = new Map()
  deptsSnap.forEach((d) => {
    const x = d.data()
    const target = x.lineGroupId || x.lineUserId
    if (target) deptMap.set(x.name, target)
    if (x.msgSwapRequest) deptMsgMap.set(x.name, x.msgSwapRequest)
    if (x.telegramChatId) deptTgMap.set(x.name, x.telegramChatId)
  })
  for (const docSnap of snap.docs) {
    const b = docSnap.data()
    const department = b.currentLocation ?? ''
    if (department === 'ห้องยา' || b.state === 'ready') {
      await docSnap.ref.update({ swapAlertActive: false, swapAlertClearedAt: FieldValue.serverTimestamp() })
      continue
    }
    const groupId = deptMap.get(department)
    if (!groupId) continue
    const boxNo = b.boxNo ?? ''
    const setBy = b.swapAlertSetBy ?? ''
    const drugLine = nearestDrugLine(b)
    const drugVars = nearestDrugVars(b)
    const isHome = !!(b.homeDepartment && String(b.homeDepartment).trim())
    const swapMsg = isHome ? '' : (deptMsgMap.get(department) || cfg.msgSwapRequest || '')
    const flex = buildSwapRequestFlex(department, boxNo, setBy, docSnap.id, swapMsg, drugLine, drugVars, isHome)
    const ok = await pushFlex(token, groupId, `แจ้งซ้ำ: นำกล่อง ${boxNo} ${isHome ? 'มาบรรจุ' : 'มาแลก'}`, flex)
    await docSnap.ref.update({ swapAlertLastSentAt: FieldValue.serverTimestamp() })
    if (!ok) {
      // LINE ล้มเหลว → fallback Telegram รายแผนก
      const tg = deptTgMap.get(department)
      if (tg) {
        const verb = isHome ? 'มาบรรจุที่ห้องยา' : 'มาแลก'
        const drugSuffix = drugVars.drug ? ` (${drugVars.drug} เหลือ ${drugVars.days} วัน)` : ''
        await sendTelegramTo(tg,
          `⚠️ <b>LINE ส่งไม่สำเร็จ — ส่งผ่าน Telegram แทน</b>\n` +
          `🏥 แผนก: <b>${department}</b>\n` +
          `แจ้งซ้ำ: นำกล่อง <b>${boxNo}</b> ${verb}${drugSuffix}`)
      }
    }
  }
  console.log(`swap reminder pushed ${snap.size} alerts`)
}

async function runCheckInReminder() {
  const [deptsSnap, boxesSnap] = await Promise.all([
    db.collection('departments').get(),
    db.collection('boxes').get(),
  ])
  const depts = deptsSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const now = dayjs()
  const allBoxes = boxesSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  const needing = []
  for (const dept of depts) {
    const deptName = dept.name
    const intervalDays = dept.checkInIntervalDays ?? 7
    const rows = []
    for (const b of allBoxes) {
      if (b.currentLocation !== deptName) continue
      if (b.state !== 'deployed') continue
      const inspectedAt = b.inspectedAt && b.inspectedAt.toDate ? b.inspectedAt.toDate() : null
      if (!inspectedAt) { rows.push({ boxNo: b.boxNo ?? '', daysSinceCheck: 999 }); continue }
      const days = now.startOf('day').diff(dayjs(inspectedAt).startOf('day'), 'day')
      if (days >= intervalDays) rows.push({ boxNo: b.boxNo ?? '', daysSinceCheck: days })
    }
    if (rows.length === 0) continue
    rows.sort((a, b) => b.daysSinceCheck - a.daysSinceCheck)
    const maxIdle = Math.max(...rows.map((r) => r.daysSinceCheck))
    needing.push({ deptName, order: dept.order ?? 999, rows, maxIdle })
  }
  if (needing.length === 0) { console.log('check-in: ไม่มีแผนกที่ค้างตรวจ'); return }

  needing.sort((a, b) => (b.maxIdle - a.maxIdle) || (a.order - b.order))
  const idleLabel = (r) => (r.daysSinceCheck >= 999 ? 'ยังไม่เคยตรวจ' : `นิ่ง ${r.daysSinceCheck} วัน`)
  const totalBoxes = needing.reduce((s, d) => s + d.rows.length, 0)
  const PER_DEPT_CAP = 20
  const deptBlocks = needing.map((d) => {
    const shown = d.rows.slice(0, PER_DEPT_CAP)
    const boxList = shown.map((r) => `   • ${r.boxNo} — ${idleLabel(r)}`).join('\n')
    const more = d.rows.length > PER_DEPT_CAP ? `\n   …และอีก ${d.rows.length - PER_DEPT_CAP} กล่อง` : ''
    return `🏥 <b>${d.deptName}</b> (${d.rows.length} กล่อง)\n${boxList}${more}`
  })
  const text =
    `📋 <b>กล่องครบกำหนดตรวจ (ไม่เคลื่อนไหว ≥ กำหนด)</b>\n` +
    `🗓️ ${dayjs().add(7, 'hour').format('D MMM YYYY')}\n` +
    `รวม ${totalBoxes} กล่อง · ${needing.length} แผนก\n\n` +
    deptBlocks.join('\n\n') +
    `\n\nℹ️ รบกวนประสานแผนกให้นำกล่องมาตรวจที่ห้องยา`
  const ok = await sendTelegram(text)
  if (!ok) {
    await reportFailure('Telegram check-in reminder', 'ส่งสรุปกล่องครบกำหนดตรวจทาง Telegram ไม่สำเร็จ — ตรวจสอบ Telegram Bot Token + Chat ID ในหน้าตั้งค่า')
    return
  }
  console.log(`check-in: ส่ง Telegram สรุป ${totalBoxes} กล่อง / ${needing.length} แผนก`)
}

async function runDailyIfDue() {
  const cfg = await getNotifConfig()
  const target = (cfg.dailyNotifyTime && /^\d{2}:\d{2}$/.test(cfg.dailyNotifyTime)) ? cfg.dailyNotifyTime : '08:00'
  const now = nowICT()
  const nowHHMM = now.format('HH:mm')
  const todayStr = now.format('YYYY-MM-DD')
  if (nowHHMM < target) return // ยังไม่ถึงเวลาที่ตั้งไว้

  const stateRef = db.collection('notif_state').doc('main')
  const stateSnap = await stateRef.get()
  const lastSent = stateSnap.exists ? stateSnap.data().lastDailyNotifyDate : undefined
  if (lastSent === todayStr) return // ส่งของวันนี้ไปแล้ว

  const token = cfg.lineToken || ''
  if (!token) {
    console.error('LINE token not set (daily)')
    await reportFailure('LINE token ไม่ได้ตั้งค่า', 'ยังไม่ได้ตั้ง LINE Channel Access Token ในหน้าตั้งค่าของระบบ')
    // mark เพื่อไม่ให้ retry รัวทั้งวัน
    await stateRef.set({ lastDailyNotifyDate: todayStr }, { merge: true })
    return
  }

  // recompute ก่อน เพื่อให้สถานะ (วันเปลี่ยน) สดใหม่ก่อนแจ้งเตือน — แทน nightlyRecompute
  await runRecomputeAllBoxes()
  const pushCount = await sendExpiryNotifications(token)
  await runSwapAlertReminder(token)
  await runCheckInReminder()

  await stateRef.set({
    lastDailyNotifyDate: todayStr,
    lastDailyNotifyAt: FieldValue.serverTimestamp(),
    lastExpiryNotifyCount: pushCount,
  }, { merge: true })
  console.log(`dailyNotifications ran at ${nowHHMM} (target ${target}) → expiry ${pushCount} depts`)
}

// ============================================================
// main
// ============================================================
async function main() {
  await processPendingAlerts()
  await processAuditTelegram()
  await runDailyIfDue()
}

main()
  .then(() => { console.log('notifier done'); process.exit(0) })
  .catch((e) => { console.error('notifier fatal', e); process.exit(1) })
