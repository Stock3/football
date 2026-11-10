// Telegram-бот «Пʼятниця 5×5». Запускається GitHub Actions (.github/workflows/bot.yml), сервер не потрібен.
// Що робить за один запуск:
//  1) забирає нові повідомлення боту (/start, /status, /stop) і привʼязує Telegram до гравця;
//  2) дякує тим, кому щойно позначили оплату;
//  3) нагадує боржникам (за розкладом з налаштувань або вручну з сайту).
//     Розклад: «через N днів після гри» або «у вибрані дні тижня», один чи кілька часів (Київ), тихі години.
// Стан бота (хто підключений, кому що вже надіслано) лежить у tg.json поруч з data.json.
// Тексти й налаштування беруться з data.json → settings; стандартні значення — з блоку DEF в index.html.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.ROOT || ".";
const TOKEN = process.env.TG_TOKEN || "";
const API = (process.env.TG_API || "https://api.telegram.org") + "/bot" + TOKEN + "/";
const MODE = process.env.MODE || "auto"; // auto | remind
const ONLY = (process.env.PLAYER || "").trim();
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const SITE = process.env.SITE || (process.env.GITHUB_REPOSITORY
  ? `https://${process.env.GITHUB_REPOSITORY.split("/")[0].toLowerCase()}.github.io/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
  : "");
const THANKS_WINDOW_DAYS = 21; // не дякувати за давні ігри (напр. коли людина підключила бота пізніше)

if (!TOKEN) { console.log("TG_TOKEN не задано: додайте секрет TG_TOKEN у Settings → Secrets → Actions"); process.exit(0); }

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const data = JSON.parse(read("data.json"));
const DEF = JSON.parse(read("index.html").match(/\/\*DEF\*\/([\s\S]*?)\/\*\/DEF\*\//)[1]);
const tgPath = path.join(ROOT, "tg.json");
let tg = {};
try { tg = JSON.parse(fs.readFileSync(tgPath, "utf8")); } catch {}
tg.offset ??= 0; tg.chats ??= {}; tg.sent ??= {}; tg.slots ??= [];
let changed = false;

// ---------- налаштування ----------
const st = data.settings || {};
const S = {};
for (const k of Object.keys(DEF)) S[k] = st[k] ?? DEF[k];
S.remind = normRemind(st.remind);
S.verdicts = { ...DEF.verdicts, ...(st.verdicts || {}) };

// Розклад нагадувань. Старий формат {after,every,max,hour} працює як є: hour стає часом відправки.
function normRemind(src) {
  const r = { ...DEF.remind, ...(src || {}) };
  if (src && !Array.isArray(src.times) && src.hour != null) { r.times = [pad2(src.hour) + ":00"]; if (src.quiet == null) r.quiet = null; }
  r.mode = r.mode === "days" ? "days" : "after";
  r.days = (Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => d >= 1 && d <= 7);
  r.times = [...new Set((Array.isArray(r.times) ? r.times : []).map(hm).filter(Boolean))].sort();
  r.quiet = r.quiet && typeof r.quiet === "object" ? { from: hm(r.quiet.from) || "", to: hm(r.quiet.to) || "" } : { from: "", to: "" };
  r.after = +r.after || 0; r.every = Math.max(1, +r.every || 1); r.max = Math.max(1, +r.max || 1);
  return r;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function hm(t) { const m = String(t ?? "").trim().match(/^(\d{1,2}):(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? pad2(+m[1]) + ":" + m[2] : ""; }

// ---------- дати (Київ) ----------
const kyiv = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, time: `${p.hour}:${p.minute}` };
};
const TODAY = kyiv(NOW);
TODAY.wd = new Date(TODAY.date + "T00:00:00Z").getUTCDay() || 7; // 1 = Пн … 7 = Нд
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const MONG = ["січня","лютого","березня","квітня","травня","червня","липня","серпня","вересня","жовтня","листопада","грудня"];
const dmon = (d) => { const p = d.split("-"); return +p[2] + " " + MONG[+p[1] - 1]; };

// ---------- дані ----------
const players = Object.fromEntries(data.players.map((p) => [p.id, p]));
const played = (g) => g.sy != null && g.sb != null && g.sy !== "" && g.sb !== "";
const tracked = (g) => played(g) && !!S.payFrom && g.date >= S.payFrom;
const payers = (g) => [...(g.y || []), ...(g.b || [])].filter((id) => id !== S.org);
const games = data.games.filter(tracked).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const unpaidOf = (pid) => games.filter((g) => payers(g).includes(pid) && !(g.paid || []).includes(pid));
const debtPhrase = (list) => {
  const ds = list.map((g) => dmon(g.date));
  return (ds.length > 1 ? "ігри " : "гру ") + (ds.length > 1 ? ds.slice(0, -1).join(", ") + " і " + ds.at(-1) : ds[0]);
};
const fmtCard = (c) => { const d = String(c || "").replace(/\D/g, ""); return d.length === 16 ? d.replace(/(\d{4})(?=\d)/g, "$1 ") : String(c || ""); };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)] || "";
const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)).replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
const sentOf = (gid, pid) => ((tg.sent[gid] ??= {})[pid] ??= { r: [] });

function vars(pid, list) {
  const g = list.at(-1);
  const side = g && (g.y || []).includes(pid) ? "y" : "b";
  const my = g ? (side === "y" ? +g.sy : +g.sb) : 0, op = g ? (side === "y" ? +g.sb : +g.sy) : 0;
  const r = my > op ? "w" : my < op ? "l" : "d";
  return {
    name: players[pid]?.name || "", date: g ? dmon(g.date) : "", score: g ? `${g.sy}:${g.sb}` : "", verdict: pick(S.verdicts[r] || []),
    sum: list.length * S.price, debt: list.length ? debtPhrase(list) : "", card: fmtCard(S.card), cardName: S.cardName ? `(${S.cardName})` : "",
    bank: S.bank || "", site: SITE,
  };
}

// ---------- Telegram ----------
async function call(method, body) {
  const r = await fetch(API + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error(`${method}: ${j.description || r.status}`); e.code = j.error_code || r.status; throw e; }
  return j.result;
}
async function send(chatId, text) {
  try { await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }); return true; }
  catch (e) { console.log("Не надіслано:", e.message); return false; }
}
async function sendTo(pid, text) {
  const ch = tg.chats[pid];
  if (!ch) return false;
  const ok = await send(ch.id, text);
  if (ok) console.log(`→ ${players[pid]?.name}: ${text.split("\n")[0]}`);
  return ok;
}

// ---------- 1. вхідні повідомлення ----------
function playerByChat(chatId) { return Object.keys(tg.chats).find((pid) => tg.chats[pid].id === chatId); }
function playerByUsername(u) { if (!u) return null; u = u.toLowerCase(); return data.players.find((p) => p.tg && p.tg.toLowerCase() === u) || null; }

async function onMessage(m) {
  const text = (m.text || "").trim(), chatId = m.chat.id, uname = m.from?.username || "";
  const [cmd, arg] = text.split(/\s+/);
  const c = (cmd || "").toLowerCase().replace(/@.*$/, "");
  if (c === "/start") {
    let p = arg ? players[arg] : playerByUsername(uname);
    if (arg && !p) return send(chatId, `Не знайшов такого гравця 🤔 Відкрий свій профіль на сайті й натисни «Підключити Telegram-бота».${SITE ? "\n" + SITE : ""}`);
    if (!p) return send(chatId, `Привіт! Щоб я знав, хто ти, відкрий свій профіль на сайті й натисни «Підключити Telegram-бота».${SITE ? "\n" + SITE : ""}`);
    if (p.tg && p.tg.toLowerCase() !== uname.toLowerCase()) return send(chatId, `Це посилання для гравця ${p.name} 🙂 Відкрий свій профіль на сайті.`);
    for (const k of Object.keys(tg.chats)) if (tg.chats[k].id === chatId && k !== p.id) delete tg.chats[k];
    tg.chats[p.id] = { id: chatId, u: uname, at: NOW.toISOString() };
    changed = true;
    console.log(`Підключено: ${p.name} (@${uname || "—"})`);
    return send(chatId, fill(S.hello, vars(p.id, [])));
  }
  const pid = playerByChat(chatId);
  if (c === "/stop") {
    if (pid) { delete tg.chats[pid]; changed = true; }
    return send(chatId, "Гаразд, більше не пишу. Повернутися: /start");
  }
  if (c === "/status" || /^борг/i.test(text) || /^оплат/i.test(text)) {
    if (!pid) return send(chatId, "Я тебе ще не знаю 🙂 Натисни /start або «Підключити Telegram-бота» у своєму профілі на сайті.");
    const list = unpaidOf(pid);
    if (!list.length) return send(chatId, `✅ ${players[pid].name}, боргів немає. Гордість бухгалтерії 🏆`);
    const v = vars(pid, list);
    return send(chatId, fill(`💸 ${v.name}, не оплачено за {debt}. Разом {sum} грн.\nКартка: {card} {cardName}${S.bank ? "\n{bank}" : ""}`, v));
  }
  return send(chatId, "Я вмію: /status — перевірити оплату, /stop — не писати мені 🙂");
}

async function pollUpdates() {
  const ups = await call("getUpdates", { offset: tg.offset, timeout: 0, allowed_updates: ["message"] });
  for (const u of ups) {
    tg.offset = u.update_id + 1; changed = true;
    const m = u.message;
    if (!m || !m.text || m.chat?.type !== "private") continue;
    await onMessage(m);
  }
}

// ---------- 2. подяки ----------
async function thanks() {
  const byPlayer = {};
  for (const g of games) {
    if (dayDiff(g.date, TODAY.date) > THANKS_WINDOW_DAYS) continue;
    for (const pid of payers(g)) {
      if (!(g.paid || []).includes(pid) || !tg.chats[pid]) continue;
      if (sentOf(g.id, pid).thx) continue;
      (byPlayer[pid] ??= []).push(g);
    }
  }
  for (const [pid, list] of Object.entries(byPlayer)) {
    if (await sendTo(pid, fill(pick(S.thanks), vars(pid, list)))) {
      for (const g of list) sentOf(g.id, pid).thx = NOW.toISOString();
      changed = true;
    }
  }
}

// ---------- 3. нагадування ----------
// У tg.sent[гра][гравець].r — записи «YYYY-MM-DD HH:MM» (слот розкладу) або «YYYY-MM-DD manual» (кнопка на сайті).
// Старі записи — просто дата. Кількість записів = скільки разів нагадали (для «максимум»).
const inQuiet = (t, q) => !!(q.from && q.to && q.from !== q.to) && (q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to);

// Слоти розкладу, що вже настали сьогодні й ще не оброблені. GitHub може запустити бота із запізненням,
// тому слот 12:00 спрацює і о 12:40, але лише один раз (оброблені слоти — у tg.slots).
function dueSlots() {
  const R = S.remind;
  if (!R.on) return [];
  if (R.mode === "days" && !R.days.includes(TODAY.wd)) return [];
  const slots = R.times.filter((t) => t <= TODAY.time).map((t) => TODAY.date + " " + t).filter((k) => !tg.slots.includes(k));
  if (!slots.length) return [];
  if (inQuiet(TODAY.time, R.quiet)) { console.log(`Тихі години (${R.quiet.from}–${R.quiet.to}): нагадування відкладено`); return []; }
  return slots;
}

async function reminders(manual) {
  const R = S.remind;
  const slots = manual ? [] : dueSlots();
  if (!manual && !slots.length) return;
  const key = manual ? TODAY.date + " manual" : slots.at(-1);
  const ids = manual && ONLY ? [ONLY] : Object.keys(tg.chats);
  for (const pid of ids) {
    if (!tg.chats[pid]) continue;
    const list = unpaidOf(pid);
    if (!list.length) continue;
    if (!manual) {
      const rs = list.map((g) => sentOf(g.id, pid).r);
      // уже нагадали в цей слот, вручну сьогодні або за старим форматом (лише дата)
      if (rs.some((r) => r.some((x) => slots.includes(x) || x === TODAY.date || x === TODAY.date + " manual"))) continue;
      const due = list.some((g) => {
        const r = sentOf(g.id, pid).r, last = r.length ? r.at(-1).slice(0, 10) : "";
        const age = dayDiff(g.date, TODAY.date);
        if (R.mode === "days" ? age < 1 : age < R.after) return false;
        if (r.length >= R.max) return false;
        // кілька часів на день: у день нагадування спрацьовує кожен слот
        return !last || last === TODAY.date || dayDiff(last, TODAY.date) >= R.every;
      });
      if (!due) continue;
    }
    if (await sendTo(pid, fill(pick(S.reminders), vars(pid, list)))) {
      for (const g of list) { const r = sentOf(g.id, pid).r; if (!r.includes(key)) r.push(key); }
      changed = true;
    }
  }
  if (slots.length) { tg.slots.push(...slots); changed = true; }
}

// ---------- запуск ----------
try { await pollUpdates(); } catch (e) { console.log("getUpdates:", e.message); }
if (S.payFrom) {
  await thanks();
  await reminders(MODE === "remind");
} else console.log("Облік оплат вимкнено (немає дати початку в налаштуваннях)");

// оброблені слоти потрібні лише на сьогодні; тримаємо тиждень про запас
{ const n = tg.slots.length; tg.slots = tg.slots.filter((k) => dayDiff(k.slice(0, 10), TODAY.date) <= 7); if (tg.slots.length !== n) changed = true; }

// прибрати стан ігор, яких уже немає
for (const gid of Object.keys(tg.sent)) if (!data.games.some((g) => g.id === gid)) { delete tg.sent[gid]; changed = true; }

// не зберігати порожні записи
for (const gid of Object.keys(tg.sent)) {
  for (const pid of Object.keys(tg.sent[gid])) { const x = tg.sent[gid][pid]; if (!x.thx && !x.r.length) delete tg.sent[gid][pid]; }
  if (!Object.keys(tg.sent[gid]).length) delete tg.sent[gid];
}

if (changed) {
  fs.writeFileSync(tgPath, JSON.stringify({ offset: tg.offset, chats: tg.chats, sent: tg.sent, slots: tg.slots }, null, 1) + "\n");
  console.log("tg.json оновлено");
} else console.log("Без змін");
