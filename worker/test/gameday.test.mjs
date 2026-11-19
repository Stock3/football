// День гри в опитуванні: черга за prio / queueFront, «Нас уже 10 ✅ … ти в черзі», нагадування кожні 30 хв, коротке «пізніше».
// Чисті функції (poll.step) без мережі; режим тесту — у testmode.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import * as poll from "../src/poll.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const DEF = core.parseDef(fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8"));
const GID = "g20261113";
const THU = new Date("2026-11-12T09:00:00Z"); // четвер, 11:00 Київ
// пʼятниця 13 листопада — день гри; Київ = UTC+2
const fri = (hm) => new Date(`2026-11-13T${String(+hm.slice(0, 2) - 2).padStart(2, "0")}:${hm.slice(3)}:00Z`);

// 12 активних (p13 Леся — неактивна, але з ботом). Черга: p12, p11, p1 (prio), далі за імʼям p2…p10. Організатор — p1.
const NAMES = ["Аня", "Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя", "Іра", "Їжак", "Йосип", "Кіра", "Леся"];
const PIDS = NAMES.map((n, i) => "p" + (i + 1));
function fixture() {
  return {
    v: 1,
    settings: { payFrom: "2026-11-01", org: "p1", remind: { on: false, quiet: { from: "22:00", to: "09:00" } } },
    players: NAMES.map((n, i) => ({ id: "p" + (i + 1), name: n, active: i < 12, ...(i === 11 ? { prio: 1 } : i === 10 ? { prio: 2 } : i === 0 ? { prio: 3 } : {}) })),
    games: [],
  };
}
const chat = (pid) => 100 + +pid.slice(1);
const chats = (skip = ["p5"]) => Object.fromEntries(PIDS.filter((p) => !skip.includes(p)).map((p) => [p, { id: chat(p), u: "" }]));
const world = (o = {}) => ({ data: o.data || fixture(), tg: o.tg || { chats: chats(o.skip) }, now: o.now || THU });
const ctxOf = (W, now) => core.context({ data: W.data, DEF, tg: W.tg, now: now || W.now, site: "", rand: () => 0 });
function go(W, ev, now) {
  const r = poll.step(ctxOf(W, now), ev);
  if (r.data) W.data = r.data;
  if (r.tg) W.tg = r.tg;
  return r;
}
const msg = (W, text, pid, now) => core.onMessage(ctxOf(W, now), { text, chat: { id: chat(pid), type: "private" }, from: {} });
function say(W, text, pid, now) { const m = msg(W, text, pid, now); return m.poll ? go(W, m.poll, now) : m; }
let cbn = 0;
const press = (W, pid, a, now) => go(W, { t: "cb", id: "q" + ++cbn, chat: chat(pid), msg: 77, data: a + "|" + GID }, now);
const tick = (W, now) => go(W, { t: "tick" }, now);
const markNo = (W, pid, now) => go(W, { t: "cb", id: "q" + ++cbn, chat: chat("p1"), msg: 77, data: "adm:no:" + pid }, now);
const P = (W) => W.tg.poll;
const G = (W) => W.data.games.find((g) => g.id === P(W).game);
const adm = (r) => (r.msgs.find((m) => m.admin) || {}).text || "";
const to = (r, pid) => r.msgs.filter((m) => m.chat === chat(pid) && !m.admin);
const invited = (W) => Object.keys(P(W).inv);
const FULL = DEF.say.full;
const GATHER_Q = (n) => `Нас уже ${n} ✅ Не сумуй — ти в черзі, напишу, якщо звільниться місце`;
// усі запрошені з ботом кажуть «Буду» (now — коли)
function allYes(W, now) { let r; for (const p of invited(W)) if (W.tg.chats[p] && P(W).inv[p].ans == null) r = press(W, p, "y", now); return r; }
function out(W, pid, now) { say(W, "/out", pid, now); return say(W, "/skip", pid, now); }

// ---------- 1. черга ----------
test("isGameDay: дата гри опитування = сьогодні за Києвом (після 00:00 Києва, а не UTC)", () => {
  const g = { date: "2026-11-13" };
  assert.equal(poll.isGameDay(ctxOf(world(), new Date("2026-11-12T21:59:00Z")), g), false); // чт 23:59 Київ
  assert.equal(poll.isGameDay(ctxOf(world(), new Date("2026-11-12T22:00:00Z")), g), true); // пт 00:00 Київ
  assert.equal(poll.isGameDay(ctxOf(world(), THU), g), false);
});

test("не в день гри: хто просився при повному складі, чекає на своєму prio-місці (вище за ще не запрошених), queueFront порожній", () => {
  const W = world(); say(W, "/poll", "p1"); allYes(W); // 9 у складі + Дана (без бота) тримає місце; не запрошені — Іра, Їжак
  // Кіра (prio 1) вийшла → її місце дістається Ірі
  out(W, "p12");
  assert.equal(P(W).inv.p9.ans, null);
  // Їжак (останній у черзі) просить місце, потім Кіра «↩️ Повернутися»
  let r = say(W, "/in", "p10");
  assert.equal(to(r, "p10")[0].text, FULL);
  assert.match(adm(r), /^↩️ Їжак хоче грати — у черзі за пріоритетом$/);
  r = press(W, "p12", "r");
  assert.equal(r.edits[0].text, FULL);
  assert.deepEqual(P(W).queueFront, []);
  assert.ok(P(W).inv.p10.req && P(W).inv.p12.req);
  // звільнилось місце → Кіра (prio 1), хоч Їжак просився раніше
  r = out(W, "p2");
  assert.match(adm(r), /запрошено: Кіра$/);
  r = out(W, "p3");
  assert.match(adm(r), /запрошено: Їжак$/);
});

test("день гри: просяться при повному складі → у кінець queueFront за часом натискання, перед чергою за prio", () => {
  const W = world(); say(W, "/poll", "p1"); allYes(W);
  out(W, "p12"); // чт: Кіра вийшла, місце — Ірі
  press(W, "p12", "r"); // чт: Кіра чекає за prio
  // пт: Їжак, потім неактивна Леся просять місце
  let r = say(W, "/in", "p10", fri("10:00"));
  assert.equal(to(r, "p10")[0].text, FULL);
  assert.match(adm(r), /^↩️ Їжак хоче грати — у черзі дня гри \(№1\)$/);
  r = say(W, "/in", "p13", fri("10:05"));
  assert.match(adm(r), /^↩️ Леся хоче грати — у черзі дня гри \(№2\)$/);
  assert.deepEqual(P(W).queueFront, ["p10", "p13"]);
  assert.ok(!to(r, "p13")[0].text.includes("№"), "номер у черзі гравцю не показуємо");
  // повторний /in не міняє порядок
  say(W, "/in", "p10", fri("10:10"));
  assert.deepEqual(P(W).queueFront, ["p10", "p13"]);
  // місця звільняються: Їжак, Леся (queueFront), лише потім Кіра (prio)
  assert.match(adm(out(W, "p2", fri("11:00"))), /запрошено: Їжак$/);
  assert.match(adm(out(W, "p3", fri("11:01"))), /запрошено: Леся$/);
  assert.match(adm(out(W, "p4", fri("11:02"))), /запрошено: Кіра$/);
  assert.deepEqual(P(W).queueFront, []);
});

test("день гри: «Передумав» після «Не зможу» при повному складі — теж у queueFront; вільне місце — як раніше одразу в гру", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p2", "n"); // місце Бориса → Іра
  allYes(W, fri("09:30"));
  let r = press(W, "p2", "c", fri("10:00"));
  assert.equal(r.answer.text, "Вже повний склад");
  assert.deepEqual(P(W).queueFront, ["p2"]);
  assert.match(adm(r), /Борис хоче грати, але склад повний — у черзі дня гри \(№1\)/);
  // вільне місце в день гри — одразу «Буду»
  const W2 = world({ data: (() => { const d = fixture(); d.players = d.players.filter((p) => ["p1", "p2", "p3", "p13"].includes(p.id)); return d; })() });
  say(W2, "/poll", "p1", fri("09:00"));
  r = say(W2, "/in", "p13", fri("10:00"));
  assert.deepEqual(G(W2).c, ["p13"]);
  assert.match(adm(r), /Леся повернувся/);
});

test("«Не зможу» прибирає гравця з черги очікування",() => {
  // не в день гри: «Не зможу» (стара кнопка) — більше не чекає місця
  const W2 = world(); say(W2, "/poll", "p1"); allYes(W2);
  say(W2, "/in", "p10");
  const n = press(W2, "p10", "n");
  assert.match(adm(n), /Їжак — більше не чекає місця/);
  assert.equal(P(W2).inv.p10.req, undefined);
  assert.match(adm(out(W2, "p2")), /запрошено: Іра$/);
  assert.match(adm(out(W2, "p3")), /Черга закінчилась/);
});

// ---------- 2. «Нас уже 10 ✅» ----------
test("«Збір є» → кожному, хто сам просився й чекає, один раз «Нас уже 10 ✅ … ти в черзі»; після збору — одразу", () => {
  const W = world({ skip: [] }); // у всіх бот, тож «Збір є» набирається
  say(W, "/poll", "p1");
  // до збору: Їжак просить місце, а всі 10 ще тримають місця → «повний склад»
  let r = say(W, "/in", "p10");
  assert.equal(to(r, "p10")[0].text, FULL);
  assert.equal(P(W).inv.p10.req != null, true);
  r = allYes(W);
  assert.ok(P(W).announced);
  assert.deepEqual(to(r, "p10").map((m) => m.text), [GATHER_Q(10)]);
  assert.ok(P(W).inv.p10.reqTold);
  assert.match(adm(r), /🔁 Черзі сказано, що склад зібрано: Їжак/);
  // більше не повторюється
  assert.equal(to(go(W, { t: "sync" }), "p10").length, 0);
  assert.equal(to(tick(W, fri("10:00")), "p10").length, 0);
  // після збору: Іра просить місце → одразу та сама відповідь (і кнопкою, і командою)
  r = say(W, "/in", "p9");
  assert.deepEqual(to(r, "p9").map((m) => m.text), [GATHER_Q(10)]);
  assert.ok(P(W).inv.p9.reqTold);
  assert.ok(!/№|\d+-?й у черзі/.test(to(r, "p9")[0].text));
  // гравець, що вийшов і хоче назад кнопкою після збору
  out(W, "p12"); // Кіра вийшла → Халепа, місце — Ірі (за prio-чергою вона раніше за Їжака)
  assert.equal(P(W).inv.p9.ans, null);
  assert.ok(P(W).inv.p10.req);
  r = press(W, "p9", "y"); // знову 10 — Їжакові вдруге «Нас уже» не пишемо
  assert.equal(to(r, "p10").length, 0);
  r = press(W, "p12", "r");
  assert.equal(r.edits[0].text, GATHER_Q(10));
});
test("«Нас уже 10»: не тим, хто відмовився, і не тим, хто чекає місця, але сказав «Не зможу»; тексти — з налаштувань (варіанти)", () => {
  const data = fixture(); data.settings.pollFull = ["{name}, нас {count}, ти в черзі"];
  const W = world({ data, skip: [] });
  say(W, "/poll", "p1");
  press(W, "p2", "n"); // відмовився — у черзі не стоїть
  say(W, "/in", "p10"); // місце є (Борис звільнив, Іра запрошена… а Їжак — у черзі)
  const r = allYes(W);
  assert.ok(P(W).announced);
  assert.equal(to(r, "p2").length, 0);
  // Їжак міг отримати місце — тоді він у грі й «Збір є», а не «Нас уже»
  const q = Object.keys(P(W).inv).filter((p) => P(W).inv[p].req);
  assert.deepEqual(q, ["p10"]);
  for (const p of q) assert.ok(to(r, p).some((m) => /^.+, нас 10, ти в черзі$/.test(m.text)));
  assert.deepEqual(DEF.pollFull, [GATHER_Q(10).replace("10", "{count}")]);
});

// ---------- 3. нагадування в день гри ----------
function remindWorld(settings) {
  const data = fixture(); Object.assign(data.settings, settings || {});
  const W = world({ data });
  say(W, "/poll", "p1");
  press(W, "p12", "y"); press(W, "p11", "n"); // Кіра буде, Йосип ні
  return W;
}
const reminded = (r) => r.msgs.filter((m) => m.inv && /ще чекаю/.test(m.text)).map((m) => m.pid).sort();
test("день гри: з 09:00 кожні 30 хв мовчазним (без бота — ні), тихі години не діють; до 09:00 — нічого", () => {
  const W = remindWorld({ remind: { on: false, quiet: { from: "22:00", to: "12:00" } } }); // тихі години до 12:00
  tick(W, new Date("2026-11-12T12:05:00Z")); // чт 14:05 — звичайне нагадування через 3 год
  assert.equal(tick(W, fri("08:45")).msgs.length, 0, "до 09:00");
  let r = tick(W, fri("09:00"));
  const silent = ["p1", "p2", "p3", "p4", "p6", "p7", "p8", "p9"].sort(); // p5 без бота, p11 відмовився (→ запрошено Іру)
  assert.deepEqual(reminded(r), silent);
  assert.match(adm(r), /^⏳ День гри, нагадав: /);
  assert.equal(adm(r).split(": ")[1].split(", ").length, silent.length, "одним рядком організатору");
  assert.ok(r.msgs.find((m) => m.pid === "p2").kb.inline_keyboard[0][0].callback_data === "y|" + GID, "з кнопками");
  assert.equal(tick(W, fri("09:15")).msgs.length, 0, "ще не 30 хв");
  // cron трохи запізнився: 09:30 → 09:29 рахується
  assert.deepEqual(reminded(tick(W, fri("09:29"))), silent);
  // Борис відповів, Вову відмітив організатор, Гліба додали на сайті
  press(W, "p2", "y", fri("09:40"));
  markNo(W, "p3", fri("09:41"));
  G(W).y = ["p4"]; go(W, { t: "sync" }, fri("09:42"));
  r = tick(W, fri("10:00"));
  const left = reminded(r);
  for (const p of ["p2", "p3", "p4", "p12", "p11"]) assert.ok(!left.includes(p), p);
  assert.ok(left.includes("p6"));
  // Вову замінив наступний (Іра вже запрошена → Їжак): його запросили о 09:41, нагадування — через 30 хв
  assert.ok(!left.includes("p10"));
  assert.ok(reminded(tick(W, fri("10:15"))).includes("p10"));
});
test("день гри: нагадування до збору складу; набралось — більше не смикаємо", () => {
  const data = fixture(); data.games.push({ id: GID, date: "2026-11-13", c: [], y: [], b: [], gy: 2, gb: 0 }); // 2 гості
  const W = world({ data, skip: [] });
  say(W, "/poll", "p1"); // запрошено 8
  for (const p of invited(W).slice(0, 7)) press(W, p, "y");
  let r = tick(W, fri("09:00"));
  assert.equal(reminded(r).length, 1);
  press(W, invited(W)[7], "y", fri("09:10"));
  assert.ok(P(W).announced);
  // хтось став «пізніше»/мовчить, але склад зібрано (гості покривають) — тиша
  assert.equal(tick(W, fri("09:30")).msgs.length, 0);
});
test("день гри: прострочене «пізніше» перепитує (і в тихі години), далі — нагадування кожні 30 хв; dayFrom/dayEvery з налаштувань", () => {
  const W = remindWorld({ poll: { dayFrom: "10:00", dayEvery: 60 }, remind: { on: false, quiet: { from: "22:00", to: "11:00" } } });
  press(W, "p2", "l"); press(W, "p2", "l30"); // чт: «пізніше» на 30 хв
  assert.equal(tick(W, new Date("2026-11-12T20:30:00Z")).msgs.length, 0, "чт 22:30 — тихі години, не день гри");
  assert.equal(tick(W, fri("09:45")).msgs.length, 0, "пт до dayFrom 10:00");
  let r = tick(W, fri("10:00"));
  assert.match(adm(r), /🕐 Борис — перепитав/);
  assert.ok(!reminded(r).includes("p2"));
  assert.ok(reminded(r).includes("p3"), "мовчазним — нагадування з 10:00");
  assert.equal(reminded(tick(W, fri("10:30"))).length, 0, "кожні 60 хв");
  r = tick(W, fri("11:00"));
  assert.ok(reminded(r).includes("p2") && reminded(r).includes("p3"));
});
test("не в день гри — як раніше: одне нагадування через 3 год і тихі години діють", () => {
  const W = remindWorld();
  assert.ok(reminded(tick(W, new Date("2026-11-12T12:05:00Z"))).length > 0);
  assert.equal(tick(W, new Date("2026-11-12T13:05:00Z")).msgs.length, 0);
  assert.equal(tick(W, new Date("2026-11-12T19:00:00Z")).msgs.length, 0);
});
test("налаштування dayFrom/dayEvery: криві значення → стандартні межі", () => {
  const S = (poll) => { const d = fixture(); d.settings.poll = poll; return ctxOf(world({ data: d })).S.poll; };
  assert.deepEqual([S({}).dayFrom, S({}).dayEvery], ["09:00", 30]);
  assert.deepEqual([S({ dayFrom: "25:00", dayEvery: 5 }).dayFrom, S({ dayEvery: 5 }).dayEvery], ["09:00", 15]);
  assert.deepEqual([S({ dayFrom: "8:30", dayEvery: "45" }).dayFrom, S({ dayEvery: "45" }).dayEvery], ["08:30", 45]);
});

// ---------- 4. «Скажу пізніше» в день гри ----------
test("день гри: «Скажу пізніше» — 15 / 30 / 60 хв, за замовчуванням 30; інші дні — 10/30/60/120, за замовчуванням 2 год", () => {
  const W = world(); say(W, "/poll", "p1");
  let r = press(W, "p3", "l", fri("10:00"));
  assert.deepEqual(r.edits[0].kb.inline_keyboard.flat().map((b) => [b.text, b.callback_data]), [["15 хв", "l15|" + GID], ["30 хв", "l30|" + GID], ["1 год", "l60|" + GID]]);
  assert.equal(r.edits[0].text, "Коли перепитати? Якщо не вибереш — через 30 хв");
  assert.equal(P(W).inv.p3.laterUntil, fri("10:30").toISOString());
  assert.match(adm(r), /Вова — відповість пізніше \(за замовчуванням через 30 хв\)/);
  r = press(W, "p3", "l15", fri("10:01"));
  assert.equal(r.edits[0].text, "Добре, перепитаю через 15 хв 🕐");
  assert.equal(tick(W, fri("10:15")).msgs.filter((m) => m.pid === "p3").length, 0);
  assert.equal(tick(W, fri("10:16")).msgs.filter((m) => m.pid === "p3").length, 1);
  // без вибору — через 30 хв
  press(W, "p4", "l", fri("11:00"));
  assert.equal(tick(W, fri("11:15")).msgs.filter((m) => m.pid === "p4").length, 0);
  assert.equal(tick(W, fri("11:30")).msgs.filter((m) => m.pid === "p4").length, 1);
  // четвер — як раніше
  const W2 = world(); say(W2, "/poll", "p1");
  r = press(W2, "p3", "l");
  assert.deepEqual(r.edits[0].kb.inline_keyboard.flat().map((b) => b.text), ["10 хв", "30 хв", "1 год", "2 год"]);
  assert.equal(r.edits[0].text, DEF.say.laterAsk);
  // стара кнопка l120 у день гри теж працює
  press(W2, "p4", "l");
  r = press(W2, "p4", "l120", fri("10:00"));
  assert.equal(r.edits[0].text, "Добре, перепитаю через 2 год 🕐");
});
