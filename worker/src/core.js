// Логіка бота «Пʼятниця 5×5» без мережі й файлів: дані + стан + час → повідомлення й зміни стану.
// Мережа (Telegram, GitHub, Open-Meteo) — в index.js. Тут лише чисті функції, тож усе тестується в Node.
//
// Зміни стану (tg.json) описуються операціями ({op:"link"|"unlink"|"thx"|"r"|"slots", …}),
// а не мутаціями: якщо запис tg.json впав з 409, index.js перечитує файл і застосовує ті самі операції ще раз.
// Операції повідомлення (напр. «подяку надіслано») застосовуються, лише якщо Telegram прийняв повідомлення.
import { WX } from "./wx.js";

export { WX };
export const THANKS_WINDOW_DAYS = 21; // не дякувати за давні ігри (напр. коли людина підключила бота пізніше)

const MONG = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const DAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

// ---------- налаштування ----------
// Блок /*DEF*/{…}/*/DEF*/ в index.html — стандартні налаштування й тексти (валідний JSON).
export function parseDef(html) {
  const m = String(html || "").match(/\/\*DEF\*\/([\s\S]*?)\/\*\/DEF\*\//);
  if (!m) throw new Error("У index.html немає блоку DEF");
  return JSON.parse(m[1]);
}
export function settings(data, DEF) {
  const st = (data && data.settings) || {};
  const S = {};
  for (const k of Object.keys(DEF)) S[k] = st[k] ?? DEF[k];
  S.remind = normRemind(st.remind, DEF);
  S.verdicts = { ...DEF.verdicts, ...(st.verdicts || {}) };
  return S;
}
// Старий формат {after,every,max,hour} працює як є: hour стає часом відправки, тихих годин немає.
export function normRemind(src, DEF) {
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
export function kyiv(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: +p.hour, time: `${p.hour}:${p.minute}`, wd: new Date(date + "T00:00:00Z").getUTCDay() || 7 }; // wd: 1 = Пн … 7 = Нд
}
export const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const dmon = (d) => { const p = d.split("-"); return +p[2] + " " + MONG[+p[1] - 1]; };
// Найближча пʼятниця за Києвом: у пʼятницю — сьогодні, із суботи — наступна.
export function nextFriday(T) {
  const d = new Date(T.date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + ((5 - T.wd + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// ---------- стан (tg.json) ----------
// { chats: {pid: {id, u, at}}, sent: {gid: {pid: {thx?, r: []}}}, slots: ["YYYY-MM-DD HH:MM"] }
// r — записи «YYYY-MM-DD HH:MM» (слот розкладу) або «YYYY-MM-DD manual» (кнопка на сайті); старі — просто дата.
export function normState(tg) {
  tg = tg && typeof tg === "object" ? tg : {};
  return { chats: { ...(tg.chats || {}) }, sent: JSON.parse(JSON.stringify(tg.sent || {})), slots: [...(tg.slots || [])] };
}
const sentGet = (tg, gid, pid) => { const x = tg.sent[gid] && tg.sent[gid][pid]; return { thx: x && x.thx, r: (x && x.r) || [] }; };

// Застосувати операції до стану. Чиста функція: можна повторити на свіжому tg.json після 409.
export function applyOps(tg, ops, data, today) {
  const s = normState(tg);
  const ent = (gid, pid) => { const g = (s.sent[gid] ??= {}); const x = (g[pid] ??= { r: [] }); x.r ??= []; return x; };
  for (const o of ops) {
    if (o.op === "link") {
      for (const k of Object.keys(s.chats)) if (s.chats[k].id === o.id && k !== o.pid) delete s.chats[k];
      s.chats[o.pid] = { id: o.id, u: o.u || "", at: o.at };
    } else if (o.op === "unlink") delete s.chats[o.pid];
    else if (o.op === "thx") { const x = ent(o.gid, o.pid); if (!x.thx) x.thx = o.at; }
    else if (o.op === "r") { const x = ent(o.gid, o.pid); if (!x.r.includes(o.key)) x.r.push(o.key); }
    else if (o.op === "slots") for (const k of o.keys) if (!s.slots.includes(k)) s.slots.push(k);
  }
  // оброблені слоти потрібні лише на сьогодні; тримаємо тиждень про запас
  if (today) s.slots = s.slots.filter((k) => dayDiff(k.slice(0, 10), today) <= 7);
  // прибрати стан ігор, яких уже немає, і порожні записи
  const ids = new Set(((data && data.games) || []).map((g) => g.id));
  for (const gid of Object.keys(s.sent)) {
    if (data && !ids.has(gid)) { delete s.sent[gid]; continue; }
    for (const pid of Object.keys(s.sent[gid])) { const x = s.sent[gid][pid]; if (!x.thx && !(x.r || []).length) delete s.sent[gid][pid]; }
    if (!Object.keys(s.sent[gid]).length) delete s.sent[gid];
  }
  return s;
}
export const sameState = (a, b) => JSON.stringify(normState(a)) === JSON.stringify(normState(b));
// Короткий опис змін для коміту «Бот: …»
export function describeOps(ops, data) {
  const name = (pid) => (data.players.find((p) => p.id === pid) || {}).name || pid;
  const parts = [];
  const links = ops.filter((o) => o.op === "link").map((o) => name(o.pid)), un = ops.filter((o) => o.op === "unlink").map((o) => name(o.pid));
  if (links.length) parts.push("підключено " + links.join(", "));
  if (un.length) parts.push("відключено " + un.join(", "));
  if (ops.some((o) => o.op === "thx")) parts.push("подяки");
  if (ops.some((o) => o.op === "r")) parts.push("нагадування");
  if (!parts.length) parts.push("оновлено стан");
  return parts.join("; ");
}

// ---------- контекст ----------
// data — data.json; DEF — з index.html; tg — tg.json; now — Date; site — адреса сайту; rand — для тестів.
export function context({ data, DEF, tg, now, site, rand }) {
  const S = settings(data, DEF);
  const T = kyiv(now);
  const players = Object.fromEntries(data.players.map((p) => [p.id, p]));
  const C = { data, DEF, S, T, now, site: site || "", tg: normState(tg), players, rand: rand || Math.random };
  C.games = data.games.filter((g) => tracked(C, g)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return C;
}
const played = (g) => !g.x && g.sy != null && g.sb != null && g.sy !== "" && g.sb !== ""; // x — скасована гра
const tracked = (C, g) => played(g) && !!C.S.payFrom && g.date >= C.S.payFrom;
const payers = (C, g) => [...(g.y || []), ...(g.b || [])].filter((id) => id !== C.S.org);
const unpaidOf = (C, pid) => C.games.filter((g) => payers(C, g).includes(pid) && !(g.paid || []).includes(pid));
const nameOf = (C, pid) => (C.players[pid] && C.players[pid].name) || pid;
const debtPhrase = (list) => {
  const ds = list.map((g) => dmon(g.date));
  return (ds.length > 1 ? "ігри " : "гру ") + (ds.length > 1 ? ds.slice(0, -1).join(", ") + " і " + ds.at(-1) : ds[0]);
};
const fmtCard = (c) => { const d = String(c || "").replace(/\D/g, ""); return d.length === 16 ? d.replace(/(\d{4})(?=\d)/g, "$1 ") : String(c || ""); };
const pick = (C, arr) => (arr && arr.length ? arr[Math.floor(C.rand() * arr.length)] : "") || "";
export const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)).replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
const gameIds = (g) => [...new Set([...(g.c || []), ...(g.y || []), ...(g.b || [])])];

function vars(C, pid, list) {
  const g = list.at(-1), S = C.S;
  const side = g && (g.y || []).includes(pid) ? "y" : "b";
  const my = g ? (side === "y" ? +g.sy : +g.sb) : 0, op = g ? (side === "y" ? +g.sb : +g.sy) : 0;
  const r = my > op ? "w" : my < op ? "l" : "d";
  return {
    name: nameOf(C, pid), date: g ? dmon(g.date) : "", score: g ? `${g.sy}:${g.sb}` : "", verdict: pick(C, S.verdicts[r]),
    sum: list.length * S.price, debt: list.length ? debtPhrase(list) : "", card: fmtCard(S.card), cardName: S.cardName ? `(${S.cardName})` : "",
    bank: S.bank || "", site: C.site,
  };
}
function gameVars(C, g, pid) {
  const ids = gameIds(g), guests = (+g.gy || 0) + (+g.gb || 0);
  return {
    name: nameOf(C, pid), date: dmon(g.date), day: DAYS[new Date(g.date + "T00:00:00Z").getUTCDay()],
    time: C.S.time || "", place: C.S.place || "", count: ids.length + guests,
    list: ids.map((id) => nameOf(C, id)).join(", ") + (guests ? ` + ${guests} ${guests === 1 ? "гість" : guests < 5 ? "гості" : "гостей"}` : ""), site: C.site,
  };
}
const toPlayer = (C, pid, text, ops) => ({ chat: C.tg.chats[pid].id, pid, name: nameOf(C, pid), text, ops: ops || [] });

// ---------- 1. вхідні повідомлення ----------
// Повертає {msgs, ops} або {weather: {chat}} — прогноз index.js дотягує з Open-Meteo сам.
export function onMessage(C, m) {
  const out = { msgs: [], ops: [] };
  if (!m || typeof m.text !== "string" || !m.chat || m.chat.type !== "private") return out;
  const text = m.text.trim(), chatId = m.chat.id, uname = (m.from && m.from.username) || "";
  const say = (t) => { out.msgs.push({ chat: chatId, text: t }); return out; };
  const [cmd, arg] = text.split(/\s+/);
  const c = (cmd || "").toLowerCase().replace(/@.*$/, "");
  const siteLine = C.site ? "\n" + C.site : "";
  if (c === "/weather" || /^погода/i.test(text)) return { ...out, weather: { chat: chatId } }; // будь-кому, навіть не підключеним
  if (c === "/start") {
    const p = arg ? C.players[arg] : uname ? C.data.players.find((x) => x.tg && x.tg.toLowerCase() === uname.toLowerCase()) : null;
    if (arg && !p) return say(`Не знайшов такого гравця 🤔 Відкрий свій профіль на сайті й натисни «Підключити Telegram-бота».${siteLine}`);
    if (!p) return say(`Привіт! Щоб я знав, хто ти, відкрий свій профіль на сайті й натисни «Підключити Telegram-бота».${siteLine}`);
    // якщо в профілі вказано username, підключитися може лише ця людина
    if (p.tg && p.tg.toLowerCase() !== uname.toLowerCase()) return say(`Це посилання для гравця ${p.name} 🙂 Відкрий свій профіль на сайті.`);
    out.ops.push({ op: "link", pid: p.id, id: chatId, u: uname, at: C.now.toISOString() });
    return say(fill(C.S.hello, vars(C, p.id, [])));
  }
  const pid = Object.keys(C.tg.chats).find((k) => C.tg.chats[k].id === chatId);
  if (c === "/stop") {
    if (pid) out.ops.push({ op: "unlink", pid });
    return say("Гаразд, більше не пишу. Повернутися: /start");
  }
  if (c === "/status" || /^борг/i.test(text) || /^оплат/i.test(text)) {
    if (!pid) return say("Я тебе ще не знаю 🙂 Натисни /start або «Підключити Telegram-бота» у своєму профілі на сайті.");
    const list = unpaidOf(C, pid);
    if (!list.length) return say(`✅ ${nameOf(C, pid)}, боргів немає. Гордість бухгалтерії 🏆`);
    const v = vars(C, pid, list);
    return say(fill(`💸 ${v.name}, не оплачено за {debt}. Разом {sum} грн.\nКартка: {card} {cardName}${C.S.bank ? "\n{bank}" : ""}`, v));
  }
  return say("Я вмію: /status — перевірити оплату, /weather — погода на пʼятницю, /stop — не писати мені 🙂");
}

// ---------- погода ----------
export function weatherReply(C, json) {
  if (!json) return "Прогноз зараз недоступний 🙈 Спробуй трохи пізніше.";
  const w = WX.build(json, nextFriday(C.T), C.S.time, C.S.rainWarn);
  return WX.text(w, { city: C.S.city, updated: C.T.time, site: C.site });
}

// ---------- 2. подяки ----------
export function thanks(C) {
  const out = { msgs: [], ops: [] };
  if (!C.S.payFrom) return out;
  const byPlayer = {};
  for (const g of C.games) {
    if (dayDiff(g.date, C.T.date) > THANKS_WINDOW_DAYS) continue;
    for (const pid of payers(C, g)) {
      if (!(g.paid || []).includes(pid) || !C.tg.chats[pid] || sentGet(C.tg, g.id, pid).thx) continue;
      (byPlayer[pid] ??= []).push(g);
    }
  }
  for (const [pid, list] of Object.entries(byPlayer)) {
    const at = C.now.toISOString();
    out.msgs.push(toPlayer(C, pid, fill(pick(C, C.S.thanks), vars(C, pid, list)), list.map((g) => ({ op: "thx", gid: g.id, pid, at }))));
  }
  return out;
}

// ---------- 3. нагадування ----------
const inQuiet = (t, q) => !!(q.from && q.to && q.from !== q.to) && (q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to);

// Слоти розкладу, що вже настали сьогодні й ще не оброблені. Cron може спрацювати із запізненням,
// тому слот 12:00 спрацює і о 12:40, але лише один раз (оброблені слоти — у tg.slots).
export function dueSlots(C) {
  const R = C.S.remind, T = C.T;
  if (!R.on) return [];
  if (R.mode === "days" && !R.days.includes(T.wd)) return [];
  const slots = R.times.filter((t) => t <= T.time).map((t) => T.date + " " + t).filter((k) => !C.tg.slots.includes(k));
  if (!slots.length || inQuiet(T.time, R.quiet)) return []; // у тихі години — чекаємо їх кінця (того ж дня)
  return slots;
}

// manual — кнопка на сайті (без розкладу й тихих годин); player — id або порожньо (усім боржникам).
// Повертає також missing — боржників без бота (лише для ручного режиму).
export function reminders(C, { manual = false, player = "" } = {}) {
  const out = { msgs: [], ops: [], missing: [] };
  if (!C.S.payFrom) return out;
  const R = C.S.remind, T = C.T;
  const slots = manual ? [] : dueSlots(C);
  if (!manual && !slots.length) return out;
  const key = manual ? T.date + " manual" : slots.at(-1);
  const ids = manual ? (player ? [player] : [...new Set(C.games.flatMap((g) => payers(C, g)))]) : Object.keys(C.tg.chats);
  for (const pid of ids) {
    const list = unpaidOf(C, pid);
    if (!list.length) continue;
    if (!C.tg.chats[pid]) { if (manual) out.missing.push(nameOf(C, pid)); continue; }
    if (!manual) {
      // уже нагадали в цей слот, вручну сьогодні або за старим форматом (лише дата)
      if (list.some((g) => sentGet(C.tg, g.id, pid).r.some((x) => slots.includes(x) || x === T.date || x === T.date + " manual"))) continue;
      const due = list.some((g) => {
        const r = sentGet(C.tg, g.id, pid).r, last = r.length ? r.at(-1).slice(0, 10) : "";
        const age = dayDiff(g.date, T.date);
        if (R.mode === "days" ? age < 1 : age < R.after) return false;
        if (r.length >= R.max) return false;
        // кілька часів на день: у день нагадування спрацьовує кожен слот
        return !last || last === T.date || dayDiff(last, T.date) >= R.every;
      });
      if (!due) continue;
    }
    out.msgs.push(toPlayer(C, pid, fill(pick(C, C.S.reminders), vars(C, pid, list)), list.map((g) => ({ op: "r", gid: g.id, pid, key }))));
  }
  if (slots.length) out.ops.push({ op: "slots", keys: slots });
  return out;
}

// ---------- 4. оголошення гри ----------
// Лише тим, хто відмічений у грі (c — «буде», y/b — команди). ann і x у data.json ставить сайт.
export function announce(C, kind, gid) {
  const out = { msgs: [], ops: [], missing: [] };
  const g = C.data.games.find((x) => x.id === gid);
  if (!g) return { ...out, error: "Гру не знайдено" };
  const texts = C.S[kind] || [];
  if (!texts.length) return { ...out, error: "Немає текстів у налаштуваннях" };
  for (const pid of gameIds(g)) {
    if (C.tg.chats[pid]) out.msgs.push(toPlayer(C, pid, fill(pick(C, texts), gameVars(C, g, pid))));
    else out.missing.push(nameOf(C, pid));
  }
  return out;
}
