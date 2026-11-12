// Тести опитування «хто йде», підсумку гри з оплатою, тихих годин і формату погоди — чисті функції без мережі.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import * as poll from "../src/poll.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8");
const DEF = core.parseDef(HTML);
const NOW = new Date("2026-11-12T09:00:00Z"); // четвер, 11:00 у Києві; гра — пт 13 листопада о 21:00
const GID = "g20261113";
const at = (h, m = 0) => new Date(NOW.getTime() + h * 3600e3 + m * 60e3);

// 12 активних (p13 — неактивний). Черга за prio: p12, p11, p1, p2 … (решта без prio — за імʼям).
// Бота немає в p5. Організатор (адмін) — p1, чат 101.
const NAMES = ["Аня", "Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя", "Іра", "Їжак", "Йосип", "Кіра", "Леся"];
function fixture() {
  return {
    v: 1,
    settings: { payFrom: "2026-11-01", org: "p1", card: "1234567812345678", remind: { on: false, quiet: { from: "22:00", to: "09:00" } } },
    players: NAMES.map((n, i) => ({ id: "p" + (i + 1), name: n, active: i < 12 })).map((p) => (p.id === "p12" ? { ...p, prio: 1 } : p.id === "p11" ? { ...p, prio: 2 } : p.id === "p1" ? { ...p, prio: 3 } : p)),
    games: [{ id: "g1", date: "2026-11-06", y: ["p1", "p2"], b: ["p3", "p4"], gy: 0, gb: 0, sy: 5, sb: 3 }],
  };
}
const chat = (pid) => 100 + +pid.slice(1);
const allChats = () => Object.fromEntries(NAMES.map((n, i) => "p" + (i + 1)).filter((p) => p !== "p5").map((p) => [p, { id: chat(p), u: "" }]));
const world = (o = {}) => ({ data: o.data || fixture(), tg: o.tg || { chats: allChats() }, now: o.now || NOW });
const ctxOf = (W, now) => core.context({ data: W.data, DEF, tg: W.tg, now: now || W.now, site: "https://site/", rand: () => 0 });
// крок як у index.js: стан записано → повідомлення «надіслано»
function go(W, ev, now) {
  const r = poll.step(ctxOf(W, now), ev);
  if (r.data) W.data = r.data;
  if (r.tg) W.tg = r.tg;
  return r;
}
const msg = (W, text, pid, now) => core.onMessage(ctxOf(W, now), { text, chat: { id: chat(pid), type: "private" }, from: {} });
// повідомлення з командою опитування → крок
function say(W, text, pid, now) { const m = msg(W, text, pid, now); return m.poll ? go(W, m.poll, now) : m; }
let cbn = 0;
const press = (W, pid, a, now) => go(W, { t: "cb", id: "q" + ++cbn, chat: chat(pid), msg: 77, data: a + "|" + GID }, now);
const P = (W) => W.tg.poll;
const G = (W) => W.data.games.find((g) => g.id === P(W).game);
const adm = (r) => (r.msgs.find((m) => m.admin) || {}).text || "";
const to = (r, pid) => r.msgs.filter((m) => m.chat === chat(pid) && !m.admin);
const invited = (W) => Object.keys(P(W).inv);
const Q = ["p12", "p11", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]; // черга
function startFull(W) { say(W, "/poll", "p1"); for (const p of invited(W)) if (p !== "p5") press(W, p, "y"); }

// ---------- старт ----------
test("/poll: створює чернетку гри на пʼятницю, запрошує 10 за пріоритетом; без бота — тримає місце, організатору 📵", () => {
  const W = world();
  const r = say(W, "/poll", "p1");
  const g = W.data.games.find((x) => x.id === GID);
  assert.deepEqual({ ...g }, { id: GID, date: "2026-11-13", c: [], y: [], b: [], gy: 0, gb: 0 });
  assert.equal(P(W).open, true);
  assert.deepEqual(invited(W), Q.slice(0, 10));
  assert.equal(P(W).inv.p5.nobot, true);
  const inv = r.msgs.filter((m) => m.inv);
  assert.equal(inv.length, 9);
  assert.deepEqual(inv[0].kb.inline_keyboard.flat().map((b) => b.text), ["✅ Буду", "❌ Не зможу", "🕐 Скажу пізніше", "🌦 Погода"]);
  assert.deepEqual(inv[0].kb.inline_keyboard.flat().map((b) => b.callback_data), ["y|" + GID, "n|" + GID, "l|" + GID, "w|" + GID]);
  assert.match(inv[0].text, /Кіра, пʼятниця, 13 листопада, о 21:00.*0\/10/);
  assert.match(adm(r), /^🚀 Опитування на 13 листопада: є 0\/10, запрошено 10: Кіра, Йосип, Аня/);
  assert.match(adm(r), /📵 Дана без бота — напиши йому сам/);
});
test("/poll: бере наявну чернетку, гості й «буде» рахуються, повторний /poll нікого не дублює", () => {
  const data = fixture();
  data.games.push({ id: "gX", date: "2026-11-13", c: ["p12"], y: ["p2"], b: [], gy: 1, gb: 1 });
  const W = world({ data });
  say(W, "/poll", "p1");
  assert.equal(P(W).game, "gX");
  assert.equal(W.data.games.length, 2);
  assert.deepEqual(invited(W), ["p11", "p1", "p3", "p4", "p5", "p6"]); // 10 − (2 гравці + 2 гості)
  const r = say(W, "/poll", "p1");
  assert.match(adm(r), /Опитування вже йде: 4\/10/);
  assert.equal(r.msgs.filter((m) => m.inv).length, 0);
});
test("/poll і /endpoll — лише організатор; /stop працює як раніше", () => {
  const W = world();
  for (const c of ["/poll", "/endpoll"]) {
    const r = msg(W, c, "p2");
    assert.equal(r.poll, undefined);
    assert.equal(r.msgs[0].text, "Ця команда лише для організатора");
  }
  assert.deepEqual(msg(W, "/stop", "p2").ops, [{ op: "unlink", pid: "p2" }]);
  say(W, "/poll", "p1");
  const r = say(W, "/endpoll", "p1");
  assert.match(adm(r), /🔒 Опитування закрито \(0\/10\)/);
  assert.equal(P(W).open, false);
  const late = press(W, "p12", "y");
  assert.equal(late.answer.text, "Опитування вже закрито");
  assert.equal(late.data, null);
});

// ---------- відповіді ----------
test("✅ Буду: у склад (c), інвайт → «Ти в грі» з «Передумав», відповідь з {count}/{need}, звіт організатору", () => {
  const W = world(); say(W, "/poll", "p1");
  const r = press(W, "p12", "y");
  assert.deepEqual(G(W).c, ["p12"]);
  assert.equal(P(W).inv.p12.ans, "yes");
  assert.equal(r.edits[0].text, "Ти в грі ✅ (1/10)");
  assert.deepEqual(r.edits[0].kb.inline_keyboard.flat().map((b) => b.callback_data), ["c|" + GID, "w|" + GID]);
  assert.match(to(r, "p12")[0].text, /1\/10/);
  assert.equal(adm(r), "✅ Кіра — буде (1/10)");
  assert.ok(r.answer && r.answer.id);
  assert.equal(press(W, "p12", "y").answer.text, "Ти вже в грі ✅");
  assert.deepEqual(G(W).c, ["p12"]);
});
test("❌ Не зможу: сумна/смішна відповідь, організатору звіт, запрошено наступного", () => {
  const W = world(); say(W, "/poll", "p1");
  const r = press(W, "p2", "n");
  assert.equal(P(W).inv.p2.ans, "no");
  assert.equal(to(r, "p2")[0].text, DEF.pollNo[0].replace("{name}", "Борис"));
  assert.equal(r.edits[0].text, "Ти пропускаєш цю гру ❌");
  assert.equal(adm(r), "❌ Борис — не зможе → запрошено: Іра"); // p9 — наступний у черзі
  assert.equal(P(W).inv.p9.ans, null);
});
test("🕐 Скажу пізніше: вибір часу, перепит у вказаний час (±15 хв), за замовчуванням 2 год", () => {
  const W = world(); say(W, "/poll", "p1");
  let r = press(W, "p3", "l");
  assert.deepEqual(r.edits[0].kb.inline_keyboard.flat().map((b) => b.text), ["10 хв", "30 хв", "1 год", "2 год"]);
  assert.match(adm(r), /🕐 Вова — відповість пізніше/);
  assert.equal(P(W).inv.p3.laterUntil, at(2).toISOString());
  r = press(W, "p3", "l60");
  assert.equal(r.edits[0].text, "Добре, перепитаю через 1 год 🕐");
  assert.equal(adm(r), "🕐 Вова — відповість через 1 год");
  assert.equal(go(W, { t: "tick" }, at(0, 45)).msgs.length, 0);
  r = go(W, { t: "tick" }, at(1, 5));
  assert.equal(to(r, "p3").length, 1);
  assert.equal(to(r, "p3")[0].kb.inline_keyboard[0][0].callback_data, "y|" + GID);
  assert.equal(P(W).inv.p3.ans, null);
  assert.match(adm(r), /Вова — перепитав/);
  // за замовчуванням — 2 год
  press(W, "p4", "l");
  assert.equal(to(go(W, { t: "tick" }, at(1, 50)), "p4").length, 0);
  assert.equal(to(go(W, { t: "tick" }, at(2, 5)), "p4").length, 1);
  // «пізніше» тримає місце: нових запрошень не було
  assert.equal(invited(W).length, 10);
});
test("мовчить 3 год → одне нагадування (без бота — ні), далі нічого автоматично", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p12", "y");
  assert.equal(go(W, { t: "tick" }, at(2, 50)).msgs.length, 0);
  const r = go(W, { t: "tick" }, at(3, 5));
  const got = r.msgs.filter((m) => m.inv).map((m) => m.pid).sort();
  assert.deepEqual(got, Q.slice(1, 10).filter((p) => p !== "p5").sort());
  assert.match(r.msgs.find((m) => m.pid === "p11").text, /ще чекаю відповідь/);
  assert.match(adm(r), /⏳ Йосип не відповів 3 год — нагадав/);
  assert.equal(go(W, { t: "tick" }, at(6)).msgs.length, 0);
  assert.equal(go(W, { t: "tick" }, at(9)).msgs.length, 0);
});
test("🌦 Погода: прогноз окремим повідомленням на дату гри, кнопки запрошення лишаються активні", () => {
  const W = world(); say(W, "/poll", "p1");
  const before = JSON.stringify(W.tg);
  const r = press(W, "p2", "w");
  assert.deepEqual(r.weather, { chat: chat("p2"), date: "2026-11-13" });
  assert.equal(r.edits.length, 0);
  assert.equal(r.tg, null);
  assert.equal(JSON.stringify(W.tg), before);
  assert.equal(press(W, "p2", "y").edits[0].text, "Ти в грі ✅ (1/10)");
});

// ---------- передумав і черга ----------
test("«Передумав» після «Буду» — як /out; після «Не зможу»: є місце → у грі, повний склад → перший у черзі", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p2", "y");
  let r = press(W, "p2", "c");
  assert.deepEqual(G(W).c, []);
  assert.match(adm(r), /^🚫 Борис скасував → запрошено: /);
  assert.equal(to(r, "p2")[0].text, "Добре, викреслив. Якщо щось зміниться — пиши 🙂");
  // склад повний (місце Бориса вже тримає новий запрошений) → у голову черги
  r = press(W, "p2", "c");
  assert.equal(r.answer.text, "Вже повний склад");
  assert.equal(r.edits[0].text, DEF.say.full);
  assert.deepEqual(P(W).queueFront, ["p2"]);
  assert.match(adm(r), /Борис хоче грати, але склад повний — перший у черзі/);
  // хтось відмовився → першим запрошують Бориса, а не наступного з черги
  r = press(W, "p3", "n");
  assert.match(adm(r), /❌ Вова — не зможе → запрошено: Борис$/);
  assert.equal(P(W).inv.p2.ans, null);
  assert.deepEqual(P(W).queueFront, []);
  // «Передумав» після «Не зможу», коли місце є
  const W2 = world(); say(W2, "/poll", "p1");
  press(W2, "p3", "n"); // місце Вови тепер у наступного; звільнимо ще одне через /endpoll? ні — через «не зможу» останнього в черзі
  for (const p of ["p9", "p10"]) press(W2, p, "n"); // черга вичерпується: 12 активних, 3 відмовились
  assert.ok(poll.count(G(W2)) + Object.values(P(W2).inv).filter((x) => x.ans == null).length < 10);
  r = press(W2, "p3", "c");
  assert.deepEqual(G(W2).c, ["p3"]);
  assert.match(adm(r), /✅ Вова — буде/);
});
test("/out: питає причину → причина організатору, наступного запрошено; /skip — без причини; не в складі — «Тебе й так немає»", () => {
  const W = world(); say(W, "/poll", "p1");
  assert.equal(say(W, "/out", "p2").msgs[0].text, "Тебе й так немає в списку");
  press(W, "p2", "y"); press(W, "p3", "y");
  let r = say(W, "/out", "p2");
  assert.equal(r.msgs[0].text, DEF.say.askReason);
  assert.ok(P(W).wait.p2);
  assert.deepEqual(G(W).c, ["p2", "p3"]); // ще не вийшов
  r = say(W, "захворів, вибачте", "p2");
  assert.deepEqual(G(W).c, ["p3"]);
  assert.equal(P(W).inv.p2.reason, "захворів, вибачте");
  assert.match(adm(r), /^🚫 Борис скасував: захворів, вибачте → запрошено: /);
  assert.equal(P(W).wait, undefined);
  say(W, "/out", "p3");
  r = say(W, "/skip", "p3");
  assert.match(adm(r), /^🚫 Вова скасував → запрошено: /);
  // поки бот чекає причину, «погода …» — теж причина, а не прогноз
  press(W, "p4", "y"); say(W, "/out", "p4");
  assert.equal(msg(W, "погода погана", "p4").poll.reason, "погода погана");
});
test("/who: групи з кількістю й іменами", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p12", "y"); press(W, "p11", "n"); press(W, "p2", "l");
  const t = say(W, "/who", "p3").msgs[0].text;
  assert.equal(t.split("\n")[0], "⚽ Пʼятниця, 13 листопада, 21:00 — 1/10");
  assert.match(t, /✅ Буде \(1\): Кіра/);
  assert.match(t, /❌ Не зможе \(1\): Йосип/);
  assert.match(t, /🕐 Скаже пізніше \(1\): Борис/);
  assert.match(t, /⏳ Не відповів \(7\): /);
  assert.match(t, /📵 Без бота \(1\): Дана/);
  assert.match(msg(W, "/who", "p13").poll ? "ok" : "", /ok/);
});
test("/no Імʼя (організатор): відмічає «не зможе» за гравця без бота й запрошує наступного", () => {
  const W = world(); say(W, "/poll", "p1");
  const r = say(W, "/no дана", "p1");
  assert.equal(P(W).inv.p5.ans, "no");
  assert.match(adm(r), /❌ Дана — не зможе \(відмітив організатор\) → запрошено: /);
});

// ---------- 10 / мінус один / знову 10 ----------
test("набралось 10 → «Збір є» всім у грі; після цього хтось вийшов → «Халепа» всім + запрошення; знову 10 → «склад» всім", () => {
  const data = fixture(); data.games.push({ id: GID, date: "2026-11-13", c: [], y: [], b: [], gy: 1, gb: 0 }); // 1 гість + 9 гравців
  const W = world({ data, tg: { chats: { ...allChats(), p5: { id: 105, u: "" } } } });
  say(W, "/poll", "p1");
  let r;
  for (const p of invited(W)) r = press(W, p, "y");
  assert.equal(poll.count(G(W)), 10);
  const gather = r.msgs.filter((m) => !m.admin && /футбол буде/.test(m.text));
  assert.equal(gather.length, 9);
  assert.equal(G(W).ann.gather, P(W).announced);
  assert.match(adm(r), /🎉 Зібрано 10\/10 — розіслано «Збір є»/);
  // мінус один після оголошення
  r = press(W, "p2", "c");
  const short = r.msgs.filter((m) => /Халепа/.test(m.text));
  assert.equal(short.length, 8);
  assert.equal(short[0].text, "😬 Халепа, нас тепер 9: Борис скасував. Шукаємо ще одного");
  assert.ok(!short.some((m) => m.chat === chat("p2")));
  assert.match(adm(r), /🚫 Борис скасував → запрошено: Зоя/);
  assert.equal(P(W).short, true);
  // знову 10
  r = press(W, "p8", "y");
  const back = r.msgs.filter((m) => /^✅ Знову 10, склад:/.test(m.text));
  assert.equal(back.length, 9);
  assert.equal(P(W).short, false);
  assert.match(adm(r), /✅ Знову 10\/10 — усім надіслано склад/);
});
test("вихід ДО «Збір є» — лише організатору й запрошення наступного, решті нічого", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p12", "y"); press(W, "p11", "y");
  const r = press(W, "p12", "c");
  assert.deepEqual(r.msgs.filter((m) => !m.admin && !m.inv).map((m) => m.pid), ["p12"]); // лише підтвердження самому
  assert.match(adm(r), /🚫 Кіра скасував → запрошено: /);
});
test("черга закінчилась → організатору один раз «⚠️ Черга закінчилась»", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p2", "n"); press(W, "p3", "n");
  const r = press(W, "p4", "n");
  assert.match(adm(r), /⚠️ Черга закінчилась, є 0\/10/);
  assert.ok(!adm(press(W, "p6", "n")).includes("⚠️"));
});

// ---------- сайт ----------
test("сайт прибрав гравця, що сказав «Буду» → як /out без причини; додав вручну → рахується", () => {
  const W = world(); say(W, "/poll", "p1");
  press(W, "p12", "y"); press(W, "p11", "y");
  G(W).c = ["p11"]; // сайт прибрав Кіру
  let r = go(W, { t: "sync" });
  assert.match(adm(r), /🚫 Кіра скасував \(прибрано на сайті\) → запрошено: /);
  assert.equal(P(W).inv.p12.ans, "no");
  G(W).y = ["p2"]; // сайт додав Бориса (він тримав запрошення)
  r = go(W, { t: "sync" });
  assert.equal(P(W).inv.p2.ans, "yes");
  assert.equal(poll.count(G(W)), 2);
  assert.equal(go(W, { t: "sync" }).tg, null, "без змін — без запису");
});
test("закриття: рахунок, скасування, час гри; після — «Опитування вже закрито»", () => {
  for (const [edit, why, now] of [[(g) => { g.sy = 5; g.sb = 4; delete g.c; }, "внесено рахунок"], [(g) => { g.x = true; }, "гру скасовано"], [() => {}, "настав час гри", new Date("2026-11-13T19:00:00Z")]]) {
    const W = world(); say(W, "/poll", "p1");
    edit(G(W));
    const r = go(W, { t: "tick" }, now);
    assert.equal(P(W).open, false, why);
    assert.match(adm(r), new RegExp("🔒 Опитування закрито: " + why));
    assert.equal(r.msgs.filter((m) => m.inv).length, 0);
    assert.equal(press(W, "p12", "y", now).answer.text, "Опитування вже закрито");
  }
  // у пʼятницю після гри /poll — уже на наступну пʼятницю
  const W = world({ now: new Date("2026-11-13T20:00:00Z") });
  say(W, "/poll", "p1");
  assert.equal(P(W).game, "g20261120");
});

// ---------- тихі години й автозапуск ----------
test("тихі години: нагадування й автозапуск чекають їх кінця; реакції на кнопки — одразу", () => {
  const data = fixture(); data.settings.poll = { auto: true, day: 4, time: "21:00" };
  const W = world({ data, now: new Date("2026-11-12T18:00:00Z") }); // чт 20:00
  assert.equal(go(W, { t: "tick" }).tg, null, "до 21:00");
  assert.equal(go(W, { t: "tick" }, new Date("2026-11-12T19:05:00Z")).tg?.poll?.game, GID, "чт 21:05 — запуск");
  // нагадування через 3 год припадає на 00:05 — тихо до 09:00
  assert.equal(go(W, { t: "tick" }, new Date("2026-11-12T22:10:00Z")).msgs.length, 0);
  const r = go(W, { t: "tick" }, new Date("2026-11-13T07:05:00Z")); // пт 09:05
  assert.ok(r.msgs.filter((m) => m.inv).length >= 8);
  // відповідь на кнопку о 23:30 — одразу
  const yes = press(W, "p12", "y", new Date("2026-11-12T21:30:00Z"));
  assert.ok(to(yes, "p12").length);
  // автозапуск у тихі години відкладається
  const data2 = fixture(); data2.settings.poll = { auto: true, day: 4, time: "23:00" };
  const W2 = world({ data2, data: data2, now: new Date("2026-11-12T21:30:00Z") }); // чт 23:30
  assert.equal(go(W2, { t: "tick" }).tg, null);
  assert.equal(go(W2, { t: "tick" }, new Date("2026-11-13T07:00:00Z")).tg?.poll?.open, true, "пт 09:00");
  // вимкнений автозапуск — нічого
  assert.equal(go(world(), { t: "tick" }).tg, null);
});
test("автозапуск один раз на гру: після /endpoll не перезапускається", () => {
  const data = fixture(); data.settings.poll = { auto: true };
  const W = world({ data });
  go(W, { t: "tick" }, at(0, 5));
  say(W, "/endpoll", "p1");
  assert.equal(go(W, { t: "tick" }, at(1)).tg, null);
});
test("тихі години для оплати: нагадування за розкладом чекають, ручне — ні", () => {
  const data = fixture(); data.settings.remind = { on: true, mode: "after", after: 1, times: ["08:00"], quiet: { from: "22:00", to: "09:00" }, every: 1, max: 3 };
  const tg = { chats: allChats() };
  assert.equal(core.reminders(core.context({ data, DEF, tg, now: new Date("2026-11-12T06:30:00Z") })).msgs.length, 0);
  assert.ok(core.reminders(core.context({ data, DEF, tg, now: new Date("2026-11-12T07:05:00Z") })).msgs.length > 0);
  assert.ok(core.reminders(core.context({ data, DEF, tg, now: new Date("2026-11-12T01:00:00Z") }), { manual: true }).msgs.length > 0);
});

// ---------- підсумок гри й оплата ----------
function pgFixture(sy, sb) {
  const data = fixture();
  data.games = [{ id: "g7", date: "2026-11-06", y: ["p1", "p2", "p3"], b: ["p4", "p6"], gy: 0, gb: 0, sy, sb, paid: ["p3"] }];
  return data;
}
const ctxNow = (data, tg, now = NOW) => core.context({ data, DEF, tg: tg || { chats: allChats() }, now, site: "", rand: () => 0 });
test("підсумок гри: тексти перемоги / поразки / нічиї з оплатою; оплачені пропускаються; організатор теж отримує", () => {
  const r = core.postGame(ctxNow(pgFixture(10, 8)), "g7");
  assert.deepEqual(r.msgs.map((m) => m.pid), ["p1", "p2", "p4", "p6"]); // p3 оплатив; p1 — організатор
  assert.equal(r.msgs[0].text, "🏆 Аня, класна гра — перемога 10:8! За гру 6 листопада: 81 грн на 1234 5678 1234 5678");
  assert.match(r.msgs.find((m) => m.pid === "p4").text, /^💪 Гліб, сьогодні не пощастило, 8:10, наступного разу наша!.*81 грн на 1234/);
  assert.match(core.postGame(ctxNow(pgFixture(4, 4)), "g7").msgs[0].text, /^🤝 Аня, нічия 4:4/);
  assert.deepEqual(r.msgs[0].ops, [{ op: "pg", gid: "g7", pid: "p1", at: NOW.toISOString() }]);
});
test("підсумок гри — ніколи двічі; без рахунку й старі ігри — ні", () => {
  const data = pgFixture(10, 8), C = ctxNow(data);
  const r = core.postGame(C);
  const tg = core.applyOps(C.tg, r.msgs.flatMap((m) => m.ops), data, C.T.date);
  assert.equal(core.postGame(ctxNow(data, tg)).msgs.length, 0);
  assert.equal(core.postGame(ctxNow(data, tg), "g7").msgs.length, 0);
  assert.equal(core.postGame(ctxNow(pgFixture(10, 8), null, new Date("2026-11-20T10:00:00Z"))).msgs.length, 0, "старше 7 днів");
  const d2 = pgFixture(10, 8); delete d2.games[0].sy; delete d2.games[0].sb;
  assert.equal(core.postGame(ctxNow(d2)).msgs.length, 0);
});
test("оплата наперед (гра ще без рахунку) → окрема подяка; організатора теж можна позначити, але боргу в нього немає", () => {
  const data = fixture();
  data.games.push({ id: GID, date: "2026-11-13", c: ["p2", "p1"], y: [], b: [], gy: 0, gb: 0, paid: ["p2", "p1"] });
  const C = ctxNow(data);
  const r = core.thanks(C);
  const p2 = r.msgs.find((m) => m.pid === "p2");
  assert.equal(p2.text, DEF.prepaid[0].replace("{name}", "Борис").replace("{sum}", "81").replace("{date}", "13 листопада"));
  assert.ok(r.msgs.find((m) => m.pid === "p1"), "організатор теж отримує подяку");
  const tg = core.applyOps(C.tg, r.msgs.flatMap((m) => m.ops), data, C.T.date);
  assert.equal(core.thanks(ctxNow(data, tg)).msgs.filter((m) => m.pid === "p2").length, 0);
  // організатор не боржник: у g1 він не оплачений, але нагадування йому немає
  assert.ok(!core.reminders(C, { manual: true }).msgs.some((m) => m.pid === "p1"));
});

// ---------- погода ----------
function wxJson(pp) { // pp — ймовірність опадів о 21:00 для ECMWF, GFS, ICON
  const time = [], h = {};
  for (let i = 0; i < 24; i++) time.push("2026-11-13T" + String(i).padStart(2, "0") + ":00");
  ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"].forEach((m, k) => {
    h["temperature_2m_" + m] = time.map(() => 6); h["apparent_temperature_" + m] = time.map(() => 3);
    h["precipitation_probability_" + m] = time.map((t, i) => (i === 21 ? pp[k] : 10)); h["precipitation_" + m] = time.map(() => 0);
    h["wind_speed_10m_" + m] = time.map(() => 4); h["weather_code_" + m] = time.map(() => 3);
  });
  return { hourly: { time, ...h } };
}
test("погода: «Вдень (08:00–20:00)», «⚽ На гру, 21:00:», без «Оновлено», три вердикти", () => {
  const C = ctxNow(fixture());
  const t = core.weatherReply(C, wxJson([10, 20, 30]), "2026-11-13");
  const L = t.split("\n");
  assert.equal(L[0], "🌦 Пʼятниця, 13 листопада · Чернівці");
  assert.match(L[1], /^Вдень \(08:00–20:00\): \+6…\+6°/);
  assert.equal(L[3], "⚽ На гру, 21:00:");
  assert.ok(!/Оновлено/.test(t) && !/https?:/.test(t));
  assert.equal(L.at(-1), "✅ Схоже, зіграємо сухими");
  assert.equal(core.weatherReply(C, wxJson([10, 50, 30]), "2026-11-13").split("\n").at(-1), "☔ Можливий дощ");
  assert.equal(core.weatherReply(C, wxJson([95, 92, 30]), "2026-11-13").split("\n").at(-1), "⚠️ Погода під питанням");
  // пороги й тексти з налаштувань; інший час гри — інший діапазон дня
  const d = fixture(); Object.assign(d.settings, { time: "19:00", rainDry: 60, wxRain: "☔ Можлива мряка" });
  const t2 = core.weatherReply(ctxNow(d), wxJson([10, 50, 30]), "2026-11-13");
  assert.match(t2, /Вдень \(08:00–18:00\)/);
  assert.match(t2, /⚽ На гру, 19:00:/);
  const d3 = fixture(); d3.settings.wxRain = "☔ Можлива мряка";
  assert.equal(core.weatherReply(ctxNow(d3), wxJson([10, 50, 30]), "2026-11-13").split("\n").at(-1), "☔ Можлива мряка");
});

// ---------- старі дані ----------
test("старі дані без prio, poll, нових текстів — працюють", () => {
  const data = fixture();
  data.players.forEach((p) => delete p.prio);
  const W = world({ data });
  say(W, "/poll", "p1");
  assert.deepEqual(invited(W), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]); // за імʼям
  const C = ctxOf(W);
  assert.deepEqual(C.S.poll, { auto: false, day: 4, time: "11:00", need: 10 });
  assert.equal(C.S.say.closed, "Опитування вже закрито");
  assert.deepEqual(core.normState({ chats: {} }), { chats: {}, sent: {}, slots: [] });
});
