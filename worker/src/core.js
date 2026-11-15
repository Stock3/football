// Логіка бота «Пʼятниця 5×5» без мережі й файлів: дані + стан + час → повідомлення й зміни стану.
// Мережа (Telegram, GitHub, Open-Meteo) — в index.js. Тут лише чисті функції, тож усе тестується в Node.
//
// Зміни стану (tg.json) описуються операціями ({op:"link"|"unlink"|"thx"|"r"|"pg"|"slots", …}),
// а не мутаціями: якщо запис tg.json впав з 409, index.js перечитує файл і застосовує ті самі операції ще раз.
// Операції повідомлення (напр. «подяку надіслано») застосовуються, лише якщо Telegram прийняв повідомлення.
// Опитування «хто йде» (tg.poll і склад гри в data.json) — окремо, у poll.js.
import { WX } from "./wx.js";
import { BAL } from "./bal.js";

export { WX, BAL };
export const THANKS_WINDOW_DAYS = 21; // не дякувати за давні ігри (напр. коли людина підключила бота пізніше)
export const POSTGAME_DAYS = 7; // підсумок гри зі списанням — лише за свіжі ігри (рахунок могли внести й пізніше)
// Тексти, у яких змінилися підстановки при переході з «боргу за гру» на баланс: старі (з {debt}, {card}, /status…) замінюються стандартними
const BAL_TEXTS = ["thanks", "reminders", "postW", "postL", "postD", "hello"];

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
  for (const k of BAL_TEXTS) if ([].concat(S[k] ?? []).some(BAL.legacy)) S[k] = DEF[k];
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
// Опитування: auto — запуск за розкладом; day — 1 = Пн … 7 = Нд; time — "HH:MM"; need — скільки треба людей;
// dayFrom / dayEvery — у день гри нагадувати мовчазним з dayFrom кожні dayEvery хв (тихі години в день гри не діють).
export function normPoll(src, DEF) {
  const p = { ...((DEF && DEF.poll) || {}), ...(src || {}) };
  p.auto = p.auto === true;
  p.day = +p.day >= 1 && +p.day <= 7 ? +p.day : 4;
  p.time = hm(p.time) || "11:00";
  p.need = Math.max(2, Math.round(+p.need) || 10);
  p.dayFrom = hm(p.dayFrom) || "09:00";
  p.dayEvery = Math.min(240, Math.max(15, Math.round(+p.dayEvery) || 30));
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
// { chats: {pid: {id, u, at}}, sent: {id: {pid: {thx?, pg?, r: []}}}, slots: ["YYYY-MM-DD HH:MM"], poll? }
// id у sent — або id гри (pg — підсумок гри зі списанням; r — нагадування про мінусовий баланс, привʼязані до останньої списаної гри),
// або id поповнення players[].top[].id (thx — подяку за поповнення надіслано). poll — стан опитування (див. poll.js).
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
  // прибрати стан ігор і поповнень, яких уже немає, і порожні записи
  const ids = new Set([...((data && data.games) || []).map((g) => g.id), ...topIds(data)]);
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
  if (ops.some((o) => o.op === "thx")) parts.push("подяки за поповнення");
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
  C.games = data.games.filter((g) => tracked(C, g) && inTestScope(C, g)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return C;
}
// ---------- режим тесту ----------
// settings.testMode: усе, що мало піти гравцям, іде в чат адміністратора (settings.org) з позначкою «👤 для Імʼя:».
// Гравці без бота вважаються підключеними (їм теж «пише» адмін). Реальним гравцям не йде нічого.
export const testOn = (C) => C.S.testMode === true;
export const adminChat = (C) => { const a = C.S.org && C.tg.chats[C.S.org]; return a ? a.id : null; };
// У режимі тесту події не від адміна ігноруються: реальні гравці нічого не отримують і нічого не змінюють
export const testBlocked = (C, chatId) => testOn(C) && (adminChat(C) == null || chatId !== adminChat(C));
// Куди писати гравцю: звичайно — у його чат; у режимі тесту — завжди адміну (null, якщо адмін без бота)
export function chatFor(C, pid) {
  if (testOn(C)) { const a = adminChat(C); return a != null ? { id: a } : null; }
  const ch = C.tg.chats[pid];
  return ch ? { id: ch.id } : null;
}
// Гравець за імʼям: без урахування регістру, точний збіг або унікальний початок. Повертає масив збігів.
export function findPlayers(C, q) {
  q = String(q || "").trim().toLowerCase();
  if (!q) return [];
  const by = (f) => C.data.players.filter((p) => f(String(p.name).toLowerCase()));
  const exact = by((n) => n === q);
  return exact.length ? exact : by((n) => n.startsWith(q));
}
// У режимі тесту подяки, підсумки й нагадування стосуються лише тестової гри (гри з опитування):
// так не спалюються прапорці «вже надіслано» для реальних ігор.
const inTestScope = (C, g) => !testOn(C) || (!!C.tg.poll && C.tg.poll.game === g.id);

export const played = (g) => BAL.played(g); // x — скасована гра
const tracked = (C, g) => BAL.charged(g, C.S); // за гру списується (зіграна з датою ≥ payFrom)
export const nameOf = (C, pid) => (C.players[pid] && C.players[pid].name) || pid;
export const fmtCard = (c) => { const d = String(c || "").replace(/\D/g, ""); return d.length === 16 ? d.replace(/(\d{4})(?=\d)/g, "$1 ") : String(c || ""); };
export const pick = (C, arr) => (arr && arr.length ? arr[Math.floor(C.rand() * arr.length)] : "") || "";
export const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)).replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
export const gameIds = (g) => [...new Set([...(g.c || []), ...(g.y || []), ...(g.b || [])])];

// ---------- баланс ----------
// Розрахунок — у спільному з сайтом блоці BAL (index.html → src/bal.js): поповнення players[].top мінус ціна гри (g.pr ?? settings.price)
// за кожну зіграну гру з датою ≥ payFrom, де гравець у y або b. Організатор теж платить, гості — ні; games[].paid не враховується.
export const topIds = (data) => ((data && data.players) || []).flatMap((p) => (Array.isArray(p.top) ? p.top : []).map((t) => t && t.id).filter(Boolean));
export const balInfo = (C, pid) => BAL.info(C.data, C.S, pid);
export const money = (n) => BAL.fmt(n);
// Банка Monobank (settings.bank) — лише коректне http(s)-посилання (Telegram відхиляє повідомлення з некоректною URL-кнопкою)
export const jarUrl = (C) => (/^https?:\/\/\S+$/.test(String(C.S.bank || "").trim()) ? String(C.S.bank).trim() : "");
// Інлайн-кнопка «💳 Поповнити» під повідомленням; без банки кнопки немає (undefined). Через deliver() доходить і в режимі тесту
export const topupKb = (C) => { const u = jarUrl(C); return u ? { inline_keyboard: [[{ text: "💳 Поповнити", url: u }]] } : undefined; };
const NO_JAR = "Посилання на банку ще не налаштоване";
// {jar} більше не підставляє посилання (його замінила кнопка): у вже збережених текстах дає порожній рядок.
// Рядок, що складався лише з {jar}, прибирається разом з переносом, щоб не лишати порожніх рядків.
const noJar = (t) => String(t).replace(/\n[ \t]*\{jar\}[ \t]*(?=\n|$)/g, "");
// Остання списана гра: «13.11, 81 грн»
const lastCharge = (I) => { if (!I.lastGame) return ""; const p = I.lastGame.d.split("-"); return `${p[2]}.${p[1]}, ${money(I.lastGame.a)} грн`; };
const balVars = (C, pid, bal) => ({ name: nameOf(C, pid), balance: money(bal), jar: "", site: C.site });

export function gameVars(C, g, pid) {
  const ids = gameIds(g), guests = (+g.gy || 0) + (+g.gb || 0);
  return {
    name: nameOf(C, pid), date: dmon(g.date), day: DAYS[new Date(g.date + "T00:00:00Z").getUTCDay()],
    time: C.S.time || "", place: C.S.place || "", count: ids.length + guests,
    list: ids.map((id) => nameOf(C, id)).join(", ") + (guests ? ` + ${guests} ${guests === 1 ? "гість" : guests < 5 ? "гості" : "гостей"}` : ""), site: C.site,
  };
}
const toPlayer = (C, pid, text, ops, kb) => ({ chat: chatFor(C, pid).id, pid, name: nameOf(C, pid), text, ops: ops || [], ...(kb ? { kb } : {}) });

// ---------- 1. вхідні повідомлення ----------
// Повертає {msgs, ops}, {weather: {chat}} — прогноз index.js дотягує з Open-Meteo сам,
// або {poll: подія} — опитування обробляє poll.step (index.js).
// as — id гравця, від імені якого адмін виконує команду (/as, лише в режимі тесту): відповіді йдуть адміну з позначкою «для Імʼя».
export function onMessage(C, m, as) {
  const out = { msgs: [], ops: [] };
  if (!m || typeof m.text !== "string" || !m.chat || m.chat.type !== "private") return out;
  const text = m.text.trim(), chatId = m.chat.id, uname = (m.from && m.from.username) || "";
  const say = (t, kb) => { out.msgs.push({ chat: chatId, text: t, ...(kb ? { kb } : {}), ...(as ? { as } : {}) }); return out; };
  const [cmd, ...rest] = text.split(/\s+/), arg = rest[0];
  const c = (cmd || "").toLowerCase().replace(/@.*$/, "");
  const siteLine = C.site ? "\n" + C.site : "";
  const pid = as || Object.keys(C.tg.chats).find((k) => C.tg.chats[k].id === chatId);
  const unknown = "Я тебе ще не знаю 🙂 Натисни /start або «Підключити Telegram-бота» у своєму профілі на сайті.";
  const P = C.tg.poll;
  const asEv = as ? { as } : {};
  // команди режиму тесту (лише адмін)
  if (!as && (c === "/as" || c === "/testreset")) {
    if (!pid || pid !== C.S.org) return say(C.S.say.adminOnly);
    if (!testOn(C)) return say("Режим тесту вимкнено. Увімкни його: Налаштування → Telegram-бот → «Режим тесту»");
    if (c === "/testreset") return { ...out, poll: { t: "testreset", chat: chatId } };
    const inner = text.replace(/^\S+\s+\S+\s*/, "");
    if (!arg || !inner) return say("Напиши так: /as Імʼя команда або текст, напр. /as Коля /out");
    const hit = findPlayers(C, arg);
    if (hit.length !== 1) return say(hit.length ? `Кілька збігів: ${hit.map((p) => p.name).join(", ")} — уточни імʼя` : `Не знайшов гравця «${arg}»`);
    return onMessage(C, { ...m, text: inner }, hit[0].id);
  }
  if (as && (c === "/start" || c === "/stop" || c === "/as" || c === "/testreset")) return say("Ця команда не працює через /as (вона змінила б реальне підключення або сам тест)");
  // після /out бот чекає причину: наступне повідомлення (не команда) — це причина, /skip — без причини
  if (pid && P && P.wait && P.wait[pid]) {
    if (c === "/skip") return { ...out, poll: { t: "out", chat: chatId, reason: "", ...asEv } };
    if (!text.startsWith("/")) return { ...out, poll: { t: "out", chat: chatId, reason: text.slice(0, 200), ...asEv } };
  }
  if (c === "/weather" || /^погода/i.test(text)) return { ...out, weather: { chat: chatId, ...asEv } }; // будь-кому, навіть не підключеним
  if (c === "/start") {
    const p = arg ? C.players[arg] : uname ? C.data.players.find((x) => x.tg && x.tg.toLowerCase() === uname.toLowerCase()) : null;
    // посилання з чужим id, а username належить іншому гравцю: не підключаємо — людина вже є в списку
    const mine = arg && uname ? C.data.players.find((x) => x.tg && x.tg.toLowerCase() === uname.toLowerCase()) : null;
    if (mine && p && mine.id !== p.id) return say(`Ти вже є в списку як ${mine.name} 🙂 Натисни /start без посилання.`);
    if (arg && !p) return say(`Не знайшов такого гравця 🤔 Відкрий свій профіль на сайті й натисни «Підключити Telegram-бота».${siteLine}`);
    if (!p) return say(`Привіт! Щоб я знав, хто ти, відкрий свій профіль на сайті й натисни «Підключити Telegram-бота».${siteLine}`);
    // якщо в профілі вказано username, підключитися може лише ця людина
    if (p.tg && p.tg.toLowerCase() !== uname.toLowerCase()) return say(`Це посилання для гравця ${p.name} 🙂 Відкрий свій профіль на сайті.`);
    out.ops.push({ op: "link", pid: p.id, id: chatId, u: uname, at: C.now.toISOString() });
    return say(fill(C.S.hello, { name: p.name, site: C.site }));
  }
  if (c === "/stop") {
    if (pid) out.ops.push({ op: "unlink", pid });
    return say("Гаразд, більше не пишу. Повернутися: /start");
  }
  // команди організатора (немає в меню); організатор — гравець settings.org з підключеним ботом
  if (c === "/poll" || c === "/endpoll" || c === "/no") {
    if (!pid || pid !== C.S.org) return say(C.S.say.adminOnly);
    return { ...out, poll: { t: c === "/poll" ? "start" : c === "/endpoll" ? "end" : "no", chat: chatId, arg: rest.join(" "), ...asEv } };
  }
  if (c === "/who" || /^хто йде/i.test(text)) {
    if (!pid) return say(unknown);
    return { ...out, poll: { t: "who", chat: chatId, ...asEv } };
  }
  if (c === "/in" || /^хочу грати/i.test(text)) {
    if (!pid) return say(unknown);
    return { ...out, poll: { t: "in", chat: chatId, ...asEv } };
  }
  if (c === "/out" || /^не зможу/i.test(text)) {
    if (!pid) return say(unknown);
    return { ...out, poll: { t: "ask", chat: chatId, ...asEv } };
  }
  if (c === "/balance" || /^баланс/i.test(text)) {
    if (!pid) return say(unknown);
    { const r = balanceReply(C, pid); return say(r.text, r.kb); }
  }
  if (c === "/topup" || /^поповн/i.test(text)) {
    if (!pid) return say(unknown);
    { const r = topupReply(C, pid); return say(r.text, r.kb); }
  }
  return say("Я вмію: /who — хто йде, /in — хочу грати, /out — не зможу прийти, /balance — мій баланс, /topup — поповнити баланс, /weather — погода на пʼятницю, /stop — не писати мені 🙂");
}

// /balance: баланс і остання списана гра; кнопка «💳 Поповнити» — завжди (хоч у плюсі), якщо є банка
export function balanceReply(C, pid) {
  const I = balInfo(C, pid), lc = lastCharge(I), kb = topupKb(C);
  return { text: `💰 Баланс: ${money(I.bal)} грн` + (lc ? `\nОстання списана гра: ${lc}` : "") + (kb ? "" : "\n" + NO_JAR), kb };
}
// /topup: баланс і кнопка «💳 Поповнити»
export function topupReply(C, pid) {
  const I = balInfo(C, pid), kb = topupKb(C);
  return { text: `💰 Баланс: ${money(I.bal)} грн\n` + (kb ? "Щойно організатор зарахує поповнення, я напишу 🙂" : NO_JAR), kb };
}

// ---------- погода ----------
// date — дата гри (кнопка 🌦 в опитуванні); без неї — найближча пʼятниця.
export function weatherReply(C, json, date) {
  if (!json) return "Прогноз зараз недоступний 🙈 Спробуй трохи пізніше.";
  const S = C.S;
  const w = WX.build(json, date || nextFriday(C.T), S.time, S.rainWarn, S.rainDry);
  return WX.text(w, { city: S.city, verdicts: { dry: S.wxDry, rain: S.wxRain, warn: S.wxWarn } });
}

// ---------- 2. подяки за поповнення ----------
// Кожне нове поповнення (players[].top з id і сумою > 0, не давніше THANKS_WINDOW_DAYS) — один раз: «зараховано X грн, баланс N грн».
// Кілька нових поповнень одного гравця — одним повідомленням (сума). Прапорець — tg.json sent[id поповнення][pid].thx.
// У режимі тесту подяки не надсилаються зовсім: поповнення реальні, тож подяка дійде гравцю, коли тест вимкнуть.
export function thanks(C) {
  const out = { msgs: [], ops: [] };
  if (testOn(C)) return out;
  const at = C.now.toISOString();
  for (const p of C.data.players) {
    const fresh = BAL.tops(p).filter((t) => t.id && +t.a > 0 && dayDiff(t.d, C.T.date) <= THANKS_WINDOW_DAYS && !sentGet(C.tg, t.id, p.id).thx);
    if (!fresh.length || !chatFor(C, p.id)) continue;
    const bal = balInfo(C, p.id).bal, sum = fresh.reduce((s, t) => s + +t.a, 0);
    out.msgs.push(toPlayer(C, p.id, fill(noJar(pick(C, C.S.thanks)), { ...balVars(C, p.id, bal), amount: money(sum), date: dmon(fresh.at(-1).d) }), fresh.map((x) => ({ op: "thx", gid: x.id, pid: p.id, at }))));
  }
  return out;
}

// ---------- 2б. підсумок гри зі списанням ----------
// Один раз кожному гравцю гри (y+b, разом з організатором): результат + «списано {charge} грн за гру {date} · баланс {balance} грн»,
// а якщо баланс у мінусі — під повідомленням кнопка «💳 Поповнити». gid — лише ця гра (кнопка сайту), без нього — усі свіжі ігри (cron-страховка).
export function postGame(C, gid) {
  const out = { msgs: [], ops: [], missing: [] };
  const at = C.now.toISOString();
  for (const g of C.games) {
    if (gid && g.id !== gid) continue;
    const age = dayDiff(g.date, C.T.date);
    if (age < 0 || age > POSTGAME_DAYS) continue;
    for (const pid of [...new Set([...(g.y || []), ...(g.b || [])])]) {
      if (sentGet(C.tg, g.id, pid).pg) continue;
      if (!chatFor(C, pid)) { out.missing.push(nameOf(C, pid)); continue; }
      const my = (g.y || []).includes(pid) ? +g.sy : +g.sb, op = (g.y || []).includes(pid) ? +g.sb : +g.sy;
      const r = my > op ? "w" : my < op ? "l" : "d";
      const list = r === "w" ? C.S.postW : r === "l" ? C.S.postL : C.S.postD;
      const bal = balInfo(C, pid).bal;
      const v = { ...balVars(C, pid, bal), date: dmon(g.date), score: `${my}:${op}`, verdict: pick(C, C.S.verdicts[r]), charge: money(BAL.charge(g, C.S)) };
      out.msgs.push(toPlayer(C, pid, fill(noJar(pick(C, list)), v), [{ op: "pg", gid: g.id, pid, at }], bal < 0 ? topupKb(C) : undefined));
    }
  }
  return out;
}

// ---------- 3. нагадування ----------
// Тихі години (Налаштування → Telegram-бот) діють лише на повідомлення за розкладом:
// нагадування про оплату, нагадування в опитуванні, «скажу пізніше», автозапуск опитування.
// У день гри нагадування й «пізніше» в опитуванні тихих годин не зважають (poll.js, tick).
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

// Кому: кожному з балансом < 0, організатору теж. Розклад рахується від останньої списаної гри гравця:
// «через N днів після гри» / «у дні тижня», не більше max нагадувань на цю гру, кожні every днів (лічильник — sent[гра][pid].r).
// Зіграв ще одну гру й досі в мінусі — лічильник починається знову з нової гри.
// manual — кнопка на сайті (без розкладу й тихих годин); player — id або порожньо (усім з мінусовим балансом).
// Повертає також missing — тих, у кого мінус, але немає бота (лише для ручного режиму).
export function reminders(C, { manual = false, player = "" } = {}) {
  const out = { msgs: [], ops: [], missing: [] };
  if (!C.S.payFrom) return out;
  const R = C.S.remind, T = C.T;
  const slots = manual ? [] : dueSlots(C);
  if (!manual && !slots.length) return out;
  const key = manual ? T.date + " manual" : slots.at(-1);
  const ids = manual && player ? [player] : manual || testOn(C) ? C.data.players.map((p) => p.id) : Object.keys(C.tg.chats);
  for (const pid of ids) {
    const bal = balInfo(C, pid).bal;
    if (!(bal < 0)) continue;
    // остання списана гра гравця (у режимі тесту — лише тестова гра)
    const g = C.games.filter((x) => BAL.inGame(x, pid)).at(-1);
    if (!manual) {
      if (!g) continue;
      const r = sentGet(C.tg, g.id, pid).r, last = r.length ? r.at(-1).slice(0, 10) : "";
      // уже нагадали в цей слот, вручну сьогодні або за старим форматом (лише дата)
      if (r.some((x) => slots.includes(x) || x === T.date || x === T.date + " manual")) continue;
      const age = dayDiff(g.date, T.date);
      if (R.mode === "days" ? age < 1 : age < R.after) continue;
      if (r.length >= R.max) continue;
      // кілька часів на день: у день нагадування спрацьовує кожен слот
      if (last && last !== T.date && dayDiff(last, T.date) < R.every) continue;
    }
    if (!chatFor(C, pid)) { if (manual) out.missing.push(nameOf(C, pid)); continue; }
    out.msgs.push(toPlayer(C, pid, fill(noJar(pick(C, C.S.reminders)), { ...balVars(C, pid, bal), date: g ? dmon(g.date) : "" }), g ? [{ op: "r", gid: g.id, pid, key }] : [], topupKb(C)));
  }
  if (slots.length && !testOn(C)) out.ops.push({ op: "slots", keys: slots }); // у тесті слот не «спалюємо»: дедуплікація — по r у грі
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
    if (chatFor(C, pid)) out.msgs.push(toPlayer(C, pid, fill(pick(C, texts), gameVars(C, g, pid))));
    else out.missing.push(nameOf(C, pid));
  }
  return out;
}
