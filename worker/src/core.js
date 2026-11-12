// Логіка бота «Пʼятниця 5×5» без мережі й файлів: дані + стан + час → повідомлення й зміни стану.
// Мережа (Telegram, GitHub, Open-Meteo) — в index.js. Тут лише чисті функції, тож усе тестується в Node.
//
// Зміни стану (tg.json) описуються операціями ({op:"link"|"unlink"|"thx"|"r"|"pg"|"slots", …}),
// а не мутаціями: якщо запис tg.json впав з 409, index.js перечитує файл і застосовує ті самі операції ще раз.
// Операції повідомлення (напр. «подяку надіслано») застосовуються, лише якщо Telegram прийняв повідомлення.
// Опитування «хто йде» (tg.poll і склад гри в data.json) — окремо, у poll.js.
import { WX } from "./wx.js";

export { WX };
export const THANKS_WINDOW_DAYS = 21; // не дякувати за давні ігри (напр. коли людина підключила бота пізніше)
export const POSTGAME_DAYS = 7; // підсумок гри з оплатою — лише за свіжі ігри (рахунок могли внести й пізніше)

const MONG = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
export const DAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

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
  S.poll = normPoll(st.poll, DEF);
  S.say = { ...(DEF.say || {}), ...(st.say || {}) };
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
// Опитування: auto — запуск за розкладом; day — 1 = Пн … 7 = Нд; time — "HH:MM"; need — скільки треба людей.
export function normPoll(src, DEF) {
  const p = { ...((DEF && DEF.poll) || {}), ...(src || {}) };
  p.auto = p.auto === true;
  p.day = +p.day >= 1 && +p.day <= 7 ? +p.day : 4;
  p.time = hm(p.time) || "11:00";
  p.need = Math.max(2, Math.round(+p.need) || 10);
  return p;
}
export function pad2(n) { return String(n).padStart(2, "0"); }
export function hm(t) { const m = String(t ?? "").trim().match(/^(\d{1,2}):(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? pad2(+m[1]) + ":" + m[2] : ""; }

// ---------- дати (Київ) ----------
export function kyiv(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: +p.hour, time: `${p.hour}:${p.minute}`, wd: new Date(date + "T00:00:00Z").getUTCDay() || 7 }; // wd: 1 = Пн … 7 = Нд
}
export const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
export const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const dmon = (d) => { const p = d.split("-"); return +p[2] + " " + MONG[+p[1] - 1]; };
// Найближча пʼятниця за Києвом: у пʼятницю — сьогодні, із суботи — наступна.
export function nextFriday(T) {
  return addDays(T.date, (5 - T.wd + 7) % 7);
}
export const gameTime = (S) => hm(S.time) || "21:00";

// ---------- стан (tg.json) ----------
// { chats: {pid: {id, u, at}}, sent: {gid: {pid: {thx?, pg?, r: []}}}, slots: ["YYYY-MM-DD HH:MM"], poll? }
// pg — коли надіслано підсумок гри з оплатою; poll — стан опитування (див. poll.js).
// r — записи «YYYY-MM-DD HH:MM» (слот розкладу) або «YYYY-MM-DD manual» (кнопка на сайті); старі — просто дата.
export function normState(tg) {
  tg = tg && typeof tg === "object" ? tg : {};
  const s = { chats: { ...(tg.chats || {}) }, sent: JSON.parse(JSON.stringify(tg.sent || {})), slots: [...(tg.slots || [])] };
  if (tg.poll && typeof tg.poll === "object") s.poll = JSON.parse(JSON.stringify(tg.poll));
  return s;
}
const sentGet = (tg, gid, pid) => { const x = tg.sent[gid] && tg.sent[gid][pid]; return { thx: x && x.thx, pg: x && x.pg, r: (x && x.r) || [] }; };

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
    else if (o.op === "pg") { const x = ent(o.gid, o.pid); if (!x.pg) x.pg = o.at; }
    else if (o.op === "r") { const x = ent(o.gid, o.pid); if (!x.r.includes(o.key)) x.r.push(o.key); }
    else if (o.op === "slots") for (const k of o.keys) if (!s.slots.includes(k)) s.slots.push(k);
  }
  // оброблені слоти потрібні лише на сьогодні; тримаємо тиждень про запас
  if (today) s.slots = s.slots.filter((k) => dayDiff(k.slice(0, 10), today) <= 7);
  // прибрати стан ігор, яких уже немає, і порожні записи
  const ids = new Set(((data && data.games) || []).map((g) => g.id));
  for (const gid of Object.keys(s.sent)) {
    if (data && !ids.has(gid)) { delete s.sent[gid]; continue; }
    for (const pid of Object.keys(s.sent[gid])) { const x = s.sent[gid][pid]; if (!x.thx && !x.pg && !(x.r || []).length) delete s.sent[gid][pid]; }
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
  if (ops.some((o) => o.op === "pg")) parts.push("підсумки гри");
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
export const played = (g) => !g.x && g.sy != null && g.sb != null && g.sy !== "" && g.sb !== ""; // x — скасована гра
const tracked = (C, g) => played(g) && !!C.S.payFrom && g.date >= C.S.payFrom;
// платять усі гравці гри, крім організатора
const payers = (C, g) => [...(g.y || []), ...(g.b || [])].filter((id) => id !== C.S.org);
const unpaidOf = (C, pid) => C.games.filter((g) => payers(C, g).includes(pid) && !(g.paid || []).includes(pid));
export const nameOf = (C, pid) => (C.players[pid] && C.players[pid].name) || pid;
const debtPhrase = (list) => {
  const ds = list.map((g) => dmon(g.date));
  return (ds.length > 1 ? "ігри " : "гру ") + (ds.length > 1 ? ds.slice(0, -1).join(", ") + " і " + ds.at(-1) : ds[0]);
};
export const fmtCard = (c) => { const d = String(c || "").replace(/\D/g, ""); return d.length === 16 ? d.replace(/(\d{4})(?=\d)/g, "$1 ") : String(c || ""); };
export const pick = (C, arr) => (arr && arr.length ? arr[Math.floor(C.rand() * arr.length)] : "") || "";
export const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)).replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
export const gameIds = (g) => [...new Set([...(g.c || []), ...(g.y || []), ...(g.b || [])])];
const payVars = (C) => ({ card: fmtCard(C.S.card), cardName: C.S.cardName ? `(${C.S.cardName})` : "", bank: C.S.bank || "", site: C.site });

function vars(C, pid, list) {
  const g = list.at(-1), S = C.S;
  const side = g && (g.y || []).includes(pid) ? "y" : "b";
  const my = g ? (side === "y" ? +g.sy : +g.sb) : 0, op = g ? (side === "y" ? +g.sb : +g.sy) : 0;
  const r = my > op ? "w" : my < op ? "l" : "d";
  return {
    name: nameOf(C, pid), date: g ? dmon(g.date) : "", score: g && played(g) ? `${g.sy}:${g.sb}` : "", verdict: g && played(g) ? pick(C, S.verdicts[r]) : "",
    sum: list.length * S.price, debt: list.length ? debtPhrase(list) : "", ...payVars(C),
  };
}
export function gameVars(C, g, pid) {
  const ids = gameIds(g), guests = (+g.gy || 0) + (+g.gb || 0);
  return {
    name: nameOf(C, pid), date: dmon(g.date), day: DAYS[new Date(g.date + "T00:00:00Z").getUTCDay()],
    time: C.S.time || "", place: C.S.place || "", count: ids.length + guests,
    list: ids.map((id) => nameOf(C, id)).join(", ") + (guests ? ` + ${guests} ${guests === 1 ? "гість" : guests < 5 ? "гості" : "гостей"}` : ""), site: C.site,
  };
}
const toPlayer = (C, pid, text, ops) => ({ chat: C.tg.chats[pid].id, pid, name: nameOf(C, pid), text, ops: ops || [] });

// ---------- 1. вхідні повідомлення ----------
// Повертає {msgs, ops}, {weather: {chat}} — прогноз index.js дотягує з Open-Meteo сам,
// або {poll: подія} — опитування обробляє poll.step (index.js).
export function onMessage(C, m) {
  const out = { msgs: [], ops: [] };
  if (!m || typeof m.text !== "string" || !m.chat || m.chat.type !== "private") return out;
  const text = m.text.trim(), chatId = m.chat.id, uname = (m.from && m.from.username) || "";
  const say = (t) => { out.msgs.push({ chat: chatId, text: t }); return out; };
  const [cmd, ...rest] = text.split(/\s+/), arg = rest[0];
  const c = (cmd || "").toLowerCase().replace(/@.*$/, "");
  const siteLine = C.site ? "\n" + C.site : "";
  const pid = Object.keys(C.tg.chats).find((k) => C.tg.chats[k].id === chatId);
  const unknown = "Я тебе ще не знаю 🙂 Натисни /start або «Підключити Telegram-бота» у своєму профілі на сайті.";
  const P = C.tg.poll;
  // після /out бот чекає причину: наступне повідомлення (не команда) — це причина, /skip — без причини
  if (pid && P && P.wait && P.wait[pid]) {
    if (c === "/skip") return { ...out, poll: { t: "out", chat: chatId, reason: "" } };
    if (!text.startsWith("/")) return { ...out, poll: { t: "out", chat: chatId, reason: text.slice(0, 200) } };
  }
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
  if (c === "/stop") {
    if (pid) out.ops.push({ op: "unlink", pid });
    return say("Гаразд, більше не пишу. Повернутися: /start");
  }
  // команди організатора (немає в меню); організатор — гравець settings.org з підключеним ботом
  if (c === "/poll" || c === "/endpoll" || c === "/no") {
    if (!pid || pid !== C.S.org) return say(C.S.say.adminOnly);
    return { ...out, poll: { t: c === "/poll" ? "start" : c === "/endpoll" ? "end" : "no", chat: chatId, arg: rest.join(" ") } };
  }
  if (c === "/who" || /^хто йде/i.test(text)) {
    if (!pid) return say(unknown);
    return { ...out, poll: { t: "who", chat: chatId } };
  }
  if (c === "/out" || /^не зможу/i.test(text)) {
    if (!pid) return say(unknown);
    return { ...out, poll: { t: "ask", chat: chatId } };
  }
  if (c === "/status" || /^борг/i.test(text) || /^оплат/i.test(text)) {
    if (!pid) return say(unknown);
    const list = unpaidOf(C, pid);
    if (!list.length) return say(`✅ ${nameOf(C, pid)}, боргів немає. Гордість бухгалтерії 🏆`);
    const v = vars(C, pid, list);
    return say(fill(`💸 ${v.name}, не оплачено за {debt}. Разом {sum} грн.\nКартка: {card} {cardName}${C.S.bank ? "\n{bank}" : ""}`, v));
  }
  return say("Я вмію: /who — хто йде, /out — не зможу прийти, /status — перевірити оплату, /weather — погода на пʼятницю, /stop — не писати мені 🙂");
}

// ---------- погода ----------
// date — дата гри (кнопка 🌦 в опитуванні); без неї — найближча пʼятниця.
export function weatherReply(C, json, date) {
  if (!json) return "Прогноз зараз недоступний 🙈 Спробуй трохи пізніше.";
  const S = C.S;
  const w = WX.build(json, date || nextFriday(C.T), S.time, S.rainWarn, S.rainDry);
  return WX.text(w, { city: S.city, verdicts: { dry: S.wxDry, rain: S.wxRain, warn: S.wxWarn } });
}

// ---------- 2. подяки ----------
// За будь-яку гру з позначеною оплатою — і зіграну, і ще заплановану (оплата наперед: окремі тексти prepaid).
// Організатор теж отримує подяку, якщо його позначили (у боргах і нагадуваннях його немає).
export function thanks(C) {
  const out = { msgs: [], ops: [] };
  if (!C.S.payFrom) return out;
  const byPlayer = {};
  for (const g of [...C.data.games].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (g.x || g.date < C.S.payFrom || dayDiff(g.date, C.T.date) > THANKS_WINDOW_DAYS) continue;
    const pl = played(g);
    for (const pid of gameIds(g)) {
      if (!(g.paid || []).includes(pid) || !C.tg.chats[pid] || sentGet(C.tg, g.id, pid).thx) continue;
      const b = (byPlayer[pid] ??= { done: [], pre: [] });
      (pl ? b.done : b.pre).push(g);
    }
  }
  const at = C.now.toISOString();
  for (const [pid, b] of Object.entries(byPlayer)) {
    if (b.done.length) out.msgs.push(toPlayer(C, pid, fill(pick(C, C.S.thanks), vars(C, pid, b.done)), b.done.map((g) => ({ op: "thx", gid: g.id, pid, at }))));
    if (b.pre.length) out.msgs.push(toPlayer(C, pid, fill(pick(C, C.S.prepaid), vars(C, pid, b.pre)), b.pre.map((g) => ({ op: "thx", gid: g.id, pid, at }))));
  }
  return out;
}

// ---------- 2б. підсумок гри з оплатою ----------
// Один раз кожному гравцю гри (y+b, разом з організатором), хто ще не позначений як оплачений.
// gid — лише ця гра (кнопка сайту), без нього — усі свіжі ігри (cron-страховка).
export function postGame(C, gid) {
  const out = { msgs: [], ops: [], missing: [] };
  const at = C.now.toISOString();
  for (const g of C.games) {
    if (gid && g.id !== gid) continue;
    const age = dayDiff(g.date, C.T.date);
    if (age < 0 || age > POSTGAME_DAYS) continue;
    for (const pid of [...new Set([...(g.y || []), ...(g.b || [])])]) {
      if ((g.paid || []).includes(pid) || sentGet(C.tg, g.id, pid).pg) continue;
      if (!C.tg.chats[pid]) { out.missing.push(nameOf(C, pid)); continue; }
      const my = (g.y || []).includes(pid) ? +g.sy : +g.sb, op = (g.y || []).includes(pid) ? +g.sb : +g.sy;
      const list = my > op ? C.S.postW : my < op ? C.S.postL : C.S.postD;
      const v = { name: nameOf(C, pid), date: dmon(g.date), score: `${my}:${op}`, sum: C.S.price, ...payVars(C) };
      out.msgs.push(toPlayer(C, pid, fill(pick(C, list), v), [{ op: "pg", gid: g.id, pid, at }]));
    }
  }
  return out;
}

// ---------- 3. нагадування ----------
// Тихі години (Налаштування → Telegram-бот) діють лише на повідомлення за розкладом:
// нагадування про оплату, нагадування в опитуванні, «скажу пізніше», автозапуск опитування.
export const inQuiet = (t, q) => !!(q && q.from && q.to && q.from !== q.to) && (q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to);

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
// Лише тим, хто відмічений у грі (c — «буде», y/b — команди). ann і x у data.json ставить сайт
// (ann.gather ставить і бот, коли опитування саме набрало потрібну кількість).
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
