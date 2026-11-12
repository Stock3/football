// Опитування «хто йде» на найближчу пʼятницю. Чиста логіка без мережі, як і core.js.
//
// step(C, ev) → { data, tg, msgs, edits, answer, weather, note, dnote }
//   data / tg — новий data.json / tg.json або null, якщо файл не змінився.
//   index.js записує спершу data.json, потім tg.json; при конфлікті (409) перечитує обидва файли й викликає step
//   ще раз на свіжих даних, тож обробники ідемпотентні (повторний «Буду» не додасть гравця двічі тощо).
//   Повідомлення надсилаються лише після успішного запису.
//
// Склад гри живе в data.json (c — «буде», y/b — команди, gy/gb — гості). У tg.json — лише стан опитування:
// poll { game, open, startedAt, closedAt?, announced, short, empty?, queueFront: [pid], wait?: {pid: ISO},
//        inv: { pid: { at, ans: "yes"|"no"|"later"|null, laterUntil?, remindedAt?, reason?, nobot? } } }
//   inv — кого бот запрошував; announced — коли розіслано «Збір є»; short — після «Збір є» когось бракує;
//   queueFront — передумали після «Не зможу», коли склад був повний: перші на наступне вільне місце;
//   wait — після /out чекаємо причину; empty — організатору вже сказано, що черга закінчилась.
//
// Події ev.t: start (/poll або автозапуск), end (/endpoll), cb (кнопка), ask (/out), out (причина або /skip),
//   who (/who), no (/no Імʼя — організатор відмічає «не зможе»), sync (сайт зберіг дані), tick (cron), nobot (не дійшло запрошення),
//   testreset (/testreset — лише в режимі тесту: скинути опитування й прапорці надсилання тестової гри).
// Режим тесту (settings.testMode): ev.as — id гравця, від імені якого діє адмін (/as; кнопка в перенаправленому повідомленні несе id
//   гравця третьою частиною callback_data «дія|гра|гравець»). Події не з чату адміна ігноруються.
import { fill, pick, nameOf, gameIds, gameVars, dmon, played, inQuiet, nextFriday, addDays, gameTime, DAYS, chatFor, testOn, testBlocked } from "./core.js";

export const REMIND_AFTER_H = 3;
const H = 3600e3;
const LATER = { l10: 10, l30: 30, l60: 60, l120: 120 };
const LATER_LABEL = { 10: "10 хв", 30: "30 хв", 60: "1 год", 120: "2 год" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- черга й підрахунок ----------
const hasPrio = (p) => p.prio != null && p.prio !== "" && isFinite(+p.prio);
export function byPrio(a, b) {
  if (hasPrio(a) !== hasPrio(b)) return hasPrio(a) ? -1 : 1;
  if (hasPrio(a) && +a.prio !== +b.prio) return +a.prio - +b.prio;
  return String(a.name).localeCompare(String(b.name), "uk");
}
// Черга запрошень: активні гравці за prio (без prio — після, за імʼям). Неактивних не запрошуємо.
export const queue = (players) => players.filter((p) => p.active !== false).sort(byPrio).map((p) => p.id);
export const need = (C) => C.S.poll.need;
export const count = (g) => gameIds(g).length + (+g.gy || 0) + (+g.gb || 0);
const inGame = (g, pid) => gameIds(g).includes(pid);
// Тримають місце: запрошені, які ще не відповіли або сказали «пізніше» (і ті, кому написати має організатор)
const holds = (P, g, pid) => !inGame(g, pid) && !!P.inv[pid] && (P.inv[pid].ans == null || P.inv[pid].ans === "later");
const holders = (P, g) => Object.keys(P.inv).filter((pid) => holds(P, g, pid));
const free = (X, g) => need(X.C) - count(g) - holders(X.P, g).length;

// Дата гри для опитування: найближча пʼятниця; у пʼятницю після часу гри — наступна.
export function pollDate(C) {
  const f = nextFriday(C.T);
  return f === C.T.date && C.T.time >= gameTime(C.S) ? addDays(f, 7) : f;
}
const pastGame = (C, g) => C.T.date > g.date || (C.T.date === g.date && C.T.time >= gameTime(C.S));

// Групи для /who і сайту
export function groups(g, P) {
  const r = { yes: gameIds(g), no: [], later: [], wait: [], nobot: [] };
  for (const [pid, x] of Object.entries((P && P.game === g.id && P.inv) || {})) {
    if (r.yes.includes(pid) || x.ans === "yes") continue;
    if (x.ans === "no") r.no.push(pid);
    else if (x.ans === "later") r.later.push(pid);
    else if (x.nobot) r.nobot.push(pid);
    else r.wait.push(pid);
  }
  return r;
}
export function whoText(C, g, P) {
  const G = groups(g, P), guests = (+g.gy || 0) + (+g.gb || 0);
  const nm = (ids) => (ids.length ? ids.map((id) => nameOf(C, id)).join(", ") : "—");
  const day = cap(DAYS[new Date(g.date + "T00:00:00Z").getUTCDay()]);
  return [
    `⚽ ${day}, ${dmon(g.date)}, ${gameTime(C.S)} — ${count(g)}/${need(C)}` + (P && P.game === g.id && !P.open ? " (опитування закрито)" : ""),
    `✅ Буде (${G.yes.length + guests}): ${G.yes.length || !guests ? nm(G.yes) : ""}${guests ? `${G.yes.length ? " + " : ""}${guests} ${guests === 1 ? "гість" : guests < 5 ? "гості" : "гостей"}` : ""}`,
    `❌ Не зможе (${G.no.length}): ${nm(G.no)}`,
    `🕐 Скаже пізніше (${G.later.length}): ${nm(G.later)}`,
    `⏳ Не відповів (${G.wait.length}): ${nm(G.wait)}`,
    `📵 Без бота (${G.nobot.length}): ${nm(G.nobot)}`,
  ].join("\n");
}

// ---------- клавіатури ----------
// callback_data: «дія|id гри» (до 64 байт)
const kb = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });
export const inviteKb = (gid) => kb([[["✅ Буду", "y|" + gid], ["❌ Не зможу", "n|" + gid]], [["🕐 Скажу пізніше", "l|" + gid], ["🌦 Погода", "w|" + gid]]]);
const changedKb = (gid) => kb([[["🔄 Передумав", "c|" + gid], ["🌦 Погода", "w|" + gid]]]);
const laterKb = (gid) => kb([Object.entries(LATER).map(([k, m]) => [LATER_LABEL[m], k + "|" + gid])]);

// ---------- крок ----------
export function step(C, ev) {
  const tg = clone(C.tg);
  const X = {
    C, ev, D: clone(C.data), tg, P: tg.poll || null, now: C.now.toISOString(),
    msgs: [], edits: [], answer: null, weather: null, head: [], tail: [], left: [], notes: [], dnotes: [],
  };
  X.pid = Object.keys(tg.chats).find((k) => tg.chats[k].id === ev.chat) || null;
  X.as = null;
  // режим тесту: адмін діє від імені гравця — ev.as (/as) або третя частина callback_data
  if (testOn(C) && !testBlocked(C, ev.chat) && ev.chat != null) {
    const tag = ev.t === "cb" ? String(ev.data || "").split("|")[2] : "";
    const as = ev.as || tag;
    if (as && C.players[as]) { X.as = as; X.pid = as; }
  }
  if (ev.t === "cb") X.answer = { id: ev.id, text: "" };
  if (ev.t === "cb" && testBlocked(C, ev.chat)) { // реальний гравець натиснув стару кнопку під час тесту: нічого не змінюємо
    X.answer.text = "Бот зараз на тестуванні 🛠";
    return finish(X);
  }
  closeIf(X);
  (HANDLERS[ev.t] || (() => {}))(X, ev);
  const g = game(X);
  if (X.P && X.P.open && g) {
    reconcile(X, g);
    const inv = fillSlots(X, g);
    if (inv.length) X.head.push("📨 Запрошено: " + inv.join(", "));
    announceCheck(X, g);
  }
  return finish(X);
}

function finish(X) {
  const org = X.C.S.org, admin = org && X.tg.chats[org];
  const lines = [...X.head, ...X.tail];
  if (lines.length && admin) X.msgs.push({ chat: admin.id, pid: org, name: nameOf(X.C, org), text: lines.join("\n"), admin: true });
  if (X.P) X.tg.poll = X.P;
  const data = JSON.stringify(X.D) !== JSON.stringify(X.C.data) ? X.D : null;
  const tg = JSON.stringify(X.tg) !== JSON.stringify(X.C.tg) ? X.tg : null;
  return { data, tg, msgs: X.msgs, edits: X.edits, answer: X.answer, weather: X.weather,
    note: X.notes.join("; ") || "опитування", dnote: X.dnotes.join("; ") || "склад гри" };
}

const game = (X) => (X.P && X.D.games.find((g) => g.id === X.P.game)) || null;
const S = (X) => X.C.S;
const say = (X, k, v) => fill(S(X).say[k] || "", v || {});
const pv = (X, g, pid, extra) => ({ ...gameVars(X.C, g, pid), need: need(X.C), ...(extra || {}) });
const arrow = (l) => (l.length ? " → запрошено: " + l.join(", ") : "");
const reply = (X, chat, text) => { if (chat != null && text) X.msgs.push({ chat, text, ...(X.as ? { as: X.as } : {}) }); };
// повідомлення гравцю; false — у гравця немає бота
function toP(X, pid, text, markup, extra) {
  const ch = chatFor(X.C, pid);
  if (!ch) return false;
  X.msgs.push({ chat: ch.id, pid, name: nameOf(X.C, pid), text, kb: markup, ...(extra || {}) });
  return true;
}
const edit = (X, m, text, markup) => { if (m && m.chat != null && m.msg != null) X.edits.push({ chat: m.chat, msg: m.msg, text, kb: markup || null, ...(X.as ? { pid: X.as } : {}) }); };
const quiet = (X) => inQuiet(X.C.T.time, S(X).remind.quiet);

function closeIf(X) {
  const P = X.P;
  if (!P || !P.open) return;
  const g = game(X);
  const why = !g ? "гру видалено" : g.x ? "гру скасовано" : played(g) ? "внесено рахунок" : pastGame(X.C, g) ? "настав час гри" : "";
  if (!why) return;
  P.open = false; P.closedAt = X.now; delete P.wait;
  X.tail.push(`🔒 Опитування закрито: ${why}`);
  X.notes.push("опитування закрито");
}

// Запросити наступних із черги на вільні місця. Повертає імена запрошених.
function fillSlots(X, g) {
  const P = X.P, out = [], q = queue(X.D.players);
  let f = free(X, g);
  while (f > 0) {
    let pid = P.queueFront.find((p) => !inGame(g, p) && !holds(P, g, p));
    if (pid) P.queueFront = P.queueFront.filter((x) => x !== pid);
    else pid = q.find((p) => !inGame(g, p) && !P.inv[p]);
    if (!pid) break;
    P.inv[pid] = { at: X.now, ans: null };
    if (!invite(X, g, pid, "pollInvite")) markNobot(X, pid);
    out.push(nameOf(X.C, pid)); f--; delete P.empty;
  }
  if (f > 0 && !P.empty) { P.empty = true; X.tail.push(`⚠️ Черга закінчилась, є ${count(g)}/${need(X.C)}`); }
  if (out.length) X.notes.push("запрошено " + out.join(", "));
  return out;
}
function invite(X, g, pid, kind) {
  return toP(X, pid, fill(pick(X.C, S(X)[kind]), pv(X, g, pid)), inviteKb(g.id), { inv: pid });
}
function markNobot(X, pid) {
  X.P.inv[pid].nobot = true;
  X.tail.push(`📵 ${nameOf(X.C, pid)} без бота — напиши йому сам`);
}

// Сайт змінив склад: хто відповів «Буду», але зник із гри — як /out без причини; кого додали — рахується.
function reconcile(X, g) {
  for (const [pid, inv] of Object.entries(X.P.inv)) {
    const inG = inGame(g, pid);
    if (inv.ans === "yes" && !inG) out(X, g, pid, "", "site");
    else if (inG && inv.ans !== "yes") { inv.ans = "yes"; delete inv.laterUntil; delete inv.nobot; X.P.queueFront = X.P.queueFront.filter((x) => x !== pid); }
  }
}

// Набралось / забракло / знову набралось
function announceCheck(X, g) {
  const P = X.P, N = need(X.C), n = count(g);
  if (!P.announced && g.ann && g.ann.gather) P.announced = g.ann.gather; // «Збір є» уже надіслали кнопкою сайту
  if (!P.announced) {
    if (n < N) return;
    for (const pid of gameIds(g)) toP(X, pid, fill(pick(X.C, S(X).gather), gameVars(X.C, g, pid)));
    P.announced = X.now; P.short = false;
    g.ann = { ...(g.ann || {}), gather: X.now };
    X.tail.push(`🎉 Зібрано ${n}/${N} — розіслано «Збір є»`);
    X.notes.push("збір є"); X.dnotes.push("збір є");
    return;
  }
  if (X.left.length && n < N) {
    for (const pid of gameIds(g)) toP(X, pid, fill(pick(X.C, S(X).pollShort), pv(X, g, pid, { who: X.left.join(", ") })));
    P.short = true;
    X.tail.push(`📣 Решті гравців: нас тепер ${n}/${N}`);
  } else if (P.short && n >= N) {
    for (const pid of gameIds(g)) toP(X, pid, fill(pick(X.C, S(X).pollBack), pv(X, g, pid)));
    P.short = false;
    X.tail.push(`✅ Знову ${n}/${N} — усім надіслано склад`);
  }
}

// ---------- відповіді ----------
function yes(X, g, pid, m) {
  const P = X.P, N = need(X.C), name = nameOf(X.C, pid);
  const inv = (P.inv[pid] ??= { at: X.now, ans: null });
  if (inGame(g, pid)) {
    if (inv.ans === "yes") { X.answer && (X.answer.text = "Ти вже в грі ✅"); edit(X, m, say(X, "inGame", { count: count(g), need: N }), changedKb(g.id)); return; }
    // уже в складі (додав сайт або попередня спроба запису) — далі як звичайне «Буду»
  } else {
    if (count(g) >= N || (!holds(P, g, pid) && free(X, g) <= 0)) return full(X, g, pid, m);
    (g.c ??= []).push(pid);
  }
  inv.ans = "yes"; delete inv.laterUntil; delete inv.nobot;
  P.queueFront = P.queueFront.filter((x) => x !== pid);
  edit(X, m, say(X, "inGame", { count: count(g), need: N }), changedKb(g.id));
  toP(X, pid, fill(pick(X.C, S(X).pollYes), pv(X, g, pid)));
  X.head.push(`✅ ${name} — буде (${count(g)}/${N})`);
  X.notes.push(name + " буде"); X.dnotes.push(name + " буде");
}
function full(X, g, pid, m) {
  const P = X.P;
  P.inv[pid] = { ...(P.inv[pid] || { at: X.now }), ans: "no" };
  delete P.inv[pid].laterUntil;
  if (!P.queueFront.includes(pid)) P.queueFront.push(pid);
  if (X.answer) X.answer.text = "Вже повний склад";
  if (m) edit(X, m, say(X, "full"), changedKb(g.id)); else toP(X, pid, say(X, "full"));
  X.head.push(`🔁 ${nameOf(X.C, pid)} хоче грати, але склад повний — перший у черзі`);
  X.notes.push(nameOf(X.C, pid) + " у черзі");
}
function no(X, g, pid, m) {
  const P = X.P, inv = (P.inv[pid] ??= { at: X.now, ans: null }), name = nameOf(X.C, pid);
  if (inGame(g, pid) || inv.ans === "yes") return out(X, g, pid, "", "changed", m);
  if (inv.ans === "no") { if (X.answer) X.answer.text = "Уже записав: не зможеш"; edit(X, m, say(X, "skipped"), changedKb(g.id)); return; }
  inv.ans = "no"; delete inv.laterUntil;
  edit(X, m, say(X, "skipped"), changedKb(g.id));
  toP(X, pid, fill(pick(X.C, S(X).pollNo), pv(X, g, pid)));
  const invd = fillSlots(X, g);
  X.head.push(`❌ ${name} — не зможе` + arrow(invd));
  X.notes.push(name + " не зможе");
}
function later(X, g, pid, m) {
  const inv = (X.P.inv[pid] ??= { at: X.now, ans: null }), name = nameOf(X.C, pid);
  if (inGame(g, pid)) { X.answer.text = "Ти вже в грі ✅"; return; }
  if (inv.ans === "no") { X.answer.text = "Натисни «Передумав», якщо зможеш"; return; }
  inv.ans = "later"; inv.laterUntil = new Date(X.C.now.getTime() + 2 * H).toISOString();
  edit(X, m, say(X, "laterAsk"), laterKb(g.id));
  X.head.push(`🕐 ${name} — відповість пізніше (за замовчуванням через 2 год)`);
  X.notes.push(name + " пізніше");
}
function laterSet(X, g, pid, mins, m) {
  const inv = X.P.inv[pid];
  if (!inv || inv.ans !== "later") { X.answer.text = "Уже неактуально"; return; }
  inv.laterUntil = new Date(X.C.now.getTime() + mins * 60e3).toISOString();
  edit(X, m, say(X, "laterOk", { after: LATER_LABEL[mins] }));
  X.head.push(`🕐 ${nameOf(X.C, pid)} — відповість через ${LATER_LABEL[mins]}`);
  X.notes.push(nameOf(X.C, pid) + " пізніше");
}
function changed(X, g, pid, m) {
  if (inGame(g, pid)) return out(X, g, pid, "", "changed", m);
  if (count(g) < need(X.C) && (holds(X.P, g, pid) || free(X, g) > 0)) return yes(X, g, pid, m);
  full(X, g, pid, m);
}
// Вихід зі складу: /out, «Передумав» після «Буду», прибрано на сайті, /no від організатора.
function out(X, g, pid, reason, src, m) {
  const P = X.P, inv = P.inv[pid], name = nameOf(X.C, pid);
  if (!inGame(g, pid) && !(inv && inv.ans === "yes")) { if (src === "cmd") toP(X, pid, say(X, "notIn")); return false; }
  for (const k of ["c", "y", "b"]) if (Array.isArray(g[k])) g[k] = g[k].filter((x) => x !== pid);
  P.inv[pid] = { ...(inv || { at: X.now }), ans: "no" };
  delete P.inv[pid].laterUntil;
  if (reason) P.inv[pid].reason = reason;
  X.left.push(name);
  const invd = fillSlots(X, g);
  const why = reason ? ": " + reason : src === "site" ? " (прибрано на сайті)" : src === "admin" ? " (відмітив організатор)" : "";
  X.head.push(`🚫 ${name} скасував${why}` + arrow(invd));
  if (src === "cmd" || src === "changed") toP(X, pid, say(X, "outOk"));
  if (m) edit(X, m, say(X, "skipped"), changedKb(g.id));
  X.notes.push(name + " скасував"); X.dnotes.push(name + " не зможе");
  return true;
}

// ---------- обробники подій ----------
const HANDLERS = {
  start: (X, ev) => start(X, !!ev.auto),
  end(X) {
    if (!X.P || !X.P.open) { X.head.push("ℹ️ Опитування зараз не йде. Запустити: /poll"); return; }
    const g = game(X);
    X.P.open = false; X.P.closedAt = X.now; delete X.P.wait;
    X.head.push(`🔒 Опитування закрито${g ? ` (${count(g)}/${need(X.C)})` : ""}`);
    X.notes.push("опитування закрито");
  },
  cb(X, ev) {
    const [a, gid] = String(ev.data || "").split("|");
    if (a === "w") { const wg = X.D.games.find((x) => x.id === gid); X.weather = { chat: ev.chat, date: wg && !played(wg) ? wg.date : null, ...(X.as ? { as: X.as } : {}) }; return; }
    if (!X.pid) { X.answer.text = "Я тебе ще не знаю 🙂 Натисни /start"; return; }
    const g = game(X);
    if (!X.P || !X.P.open || X.P.game !== gid || !g) { X.answer.text = say(X, "closed"); return; }
    const m = { chat: ev.chat, msg: ev.msg };
    if (a === "y") yes(X, g, X.pid, m);
    else if (a === "n") no(X, g, X.pid, m);
    else if (a === "l") later(X, g, X.pid, m);
    else if (LATER[a]) laterSet(X, g, X.pid, LATER[a], m);
    else if (a === "c") changed(X, g, X.pid, m);
  },
  ask(X, ev) {
    const g = game(X), pid = X.pid;
    if (!pid) return;
    if (!X.P || !X.P.open || !g) return reply(X, ev.chat, say(X, "noPoll"));
    const inv = X.P.inv[pid];
    if (!inGame(g, pid) && !(inv && inv.ans === "yes")) return reply(X, ev.chat, say(X, "notIn"));
    (X.P.wait ??= {})[pid] = X.now;
    reply(X, ev.chat, say(X, "askReason"));
  },
  out(X, ev) {
    const pid = X.pid;
    if (!pid) return;
    if (X.P && X.P.wait) { delete X.P.wait[pid]; if (!Object.keys(X.P.wait).length) delete X.P.wait; }
    const g = game(X);
    if (!X.P || !X.P.open || !g) return reply(X, ev.chat, say(X, "closed"));
    out(X, g, pid, ev.reason || "", "cmd");
  },
  who(X, ev) {
    let g = game(X);
    if (!g || played(g) || g.x) g = X.D.games.filter((x) => !played(x) && !x.x && x.date >= X.C.T.date).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    reply(X, ev.chat, g ? whoText(X.C, g, X.P) : say(X, "noPoll"));
  },
  no(X, ev) {
    const g = game(X), q = String(ev.arg || "").trim().toLowerCase();
    if (!X.P || !X.P.open || !g) { X.head.push("ℹ️ Опитування зараз не йде"); return; }
    if (!q) { X.head.push("Напиши так: /no Імʼя — відмітити, що гравець не зможе"); return; }
    const ids = [...new Set([...gameIds(g), ...Object.keys(X.P.inv)])];
    const by = (f) => ids.filter((id) => f(String(nameOf(X.C, id)).toLowerCase()));
    let c = by((n) => n === q); if (!c.length) c = by((n) => n.startsWith(q));
    if (c.length !== 1) { X.head.push(c.length ? `Кілька збігів: ${c.map((id) => nameOf(X.C, id)).join(", ")} — уточни імʼя` : `Не знайшов «${ev.arg}» серед запрошених і в складі`); return; }
    const pid = c[0], inv = X.P.inv[pid];
    if (inGame(g, pid) || (inv && inv.ans === "yes")) { out(X, g, pid, "", "admin"); return; }
    inv.ans = "no"; delete inv.laterUntil; delete inv.nobot;
    const invd = fillSlots(X, g);
    X.head.push(`❌ ${nameOf(X.C, pid)} — не зможе (відмітив організатор)` + arrow(invd));
    X.notes.push(nameOf(X.C, pid) + " не зможе");
  },
  testreset(X) {
    if (!testOn(X.C)) { X.head.push("ℹ️ /testreset працює лише в режимі тесту"); return; }
    const gid = X.P && X.P.game;
    if (!gid) { X.head.push("ℹ️ Опитування немає — нема що скидати"); return; }
    delete X.tg.poll; X.P = null;
    delete X.tg.sent[gid];
    X.head.push(`🧹 Тест скинуто: опитування й прапорці надсилання гри ${gid}. Склад у data.json не чіпав — чернетку гри видали на сайті сам`);
    X.notes.push("тест скинуто");
  },
  sync() {}, // усе робить reconcile/fillSlots/announceCheck у step
  nobot(X, ev) {
    if (!X.P) return;
    for (const pid of ev.pids || []) { const inv = X.P.inv[pid]; if (inv && inv.ans == null && !inv.nobot) markNobot(X, pid); }
  },
  tick(X) {
    if (quiet(X)) return; // усе тут — за розкладом, тож чекає кінця тихих годин
    if (S(X).poll.auto) autoStart(X);
    const g = game(X);
    if (!X.P || !X.P.open || !g) return;
    const now = X.C.now.getTime();
    for (const [pid, inv] of Object.entries(X.P.inv)) {
      if (inGame(g, pid)) continue;
      const name = nameOf(X.C, pid);
      if (inv.ans === "later" && inv.laterUntil && Date.parse(inv.laterUntil) <= now) {
        inv.ans = null; inv.at = X.now; delete inv.laterUntil;
        if (invite(X, g, pid, "pollInvite")) X.head.push(`🕐 ${name} — перепитав`); else markNobot(X, pid);
        X.notes.push(name + " перепитано");
      } else if (inv.ans == null && !inv.nobot && !inv.remindedAt && now - Date.parse(inv.at) >= REMIND_AFTER_H * H) {
        inv.remindedAt = X.now;
        if (invite(X, g, pid, "pollRemind")) X.head.push(`⏳ ${name} не відповів ${REMIND_AFTER_H} год — нагадав`); else markNobot(X, pid);
        X.notes.push(name + " нагадано");
      }
    }
  },
};

function start(X, auto) {
  const C = X.C, date = pollDate(C), N = need(C);
  const same = X.D.games.filter((g) => g.date === date);
  const bad = same.find((g) => g.x || played(g));
  if (bad) { if (!auto) X.head.push(`ℹ️ Гра ${dmon(date)} уже ${bad.x ? "скасована" : "зіграна"} — опитування не запускаю`); return; }
  let g = same[0];
  if (!g) {
    let id = "g" + date.replace(/-/g, "");
    while (X.D.games.some((x) => x.id === id)) id += "b";
    g = { id, date, c: [], y: [], b: [], gy: 0, gb: 0 };
    X.D.games.push(g);
    X.D.games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    X.dnotes.push("нова гра " + date);
  }
  if (X.P && X.P.game === g.id && X.P.open) { X.head.push(`ℹ️ Опитування вже йде: ${count(g)}/${N}`); return; }
  if (X.P && X.P.game === g.id) { X.P.open = true; delete X.P.closedAt; delete X.P.empty; }
  else X.P = X.tg.poll = { game: g.id, open: true, startedAt: X.now, announced: (g.ann && g.ann.gather) || null, short: false, queueFront: [], inv: {} };
  const invd = fillSlots(X, g);
  X.head.unshift(`🚀 Опитування на ${dmon(date)}${auto ? " (автоматично)" : ""}: є ${count(g)}/${N}` + (invd.length ? `, запрошено ${invd.length}: ${invd.join(", ")}` : ""));
  X.notes.unshift("старт опитування " + date);
}
// Автозапуск: з poll.day poll.time перед грою (поза тихими годинами), один раз на гру
function autoStart(X) {
  const C = X.C, date = pollDate(C), p = S(X).poll;
  const from = addDays(date, -((5 - p.day + 7) % 7));
  if (C.T.date < from || (C.T.date === from && C.T.time < p.time)) return;
  const same = X.D.games.filter((g) => g.date === date);
  if (same.some((g) => g.x || played(g))) return;
  const gid = (same[0] && same[0].id) || "g" + date.replace(/-/g, "");
  if (X.P && X.P.game === gid) return;
  start(X, true);
}
