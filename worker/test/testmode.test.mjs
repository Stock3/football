// Тести режиму тесту (settings.testMode): index.js з підміненим fetch (моки Telegram і GitHub) і зафіксованим годинником.
// Головне: при testMode жодне повідомлення не йде в чат не-адміна, кнопки й /as діють від імені гравця, при вимкненому — усе як раніше.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import worker from "../src/index.js";

Math.random = () => 0; // бот обирає випадковий варіант тексту — у тестах завжди перший
const dir = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8");
const DEF = core.parseDef(HTML);
const THU = new Date("2026-11-12T09:00:00Z"); // четвер, 11:00 у Києві; гра — пʼятниця 13 листопада
const FRI_EVE = new Date("2026-11-13T17:00:00Z"); // пʼятниця, 19:00: до гри ще дві години
const SAT_NOON = new Date("2026-11-14T10:00:00Z"); // субота, 12:00
const GID = "g20261113";
const ADMIN = 101;

const NAMES = ["Аня", "Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя", "Іра", "Їжак", "Йосип", "Кіра", "Богдан"];
const chat = (pid) => 100 + +pid.slice(1);
const pidOf = (name) => "p" + (NAMES.indexOf(name) + 1);
function fixture(testMode = true) {
  return {
    v: 1,
    settings: { payFrom: "2026-11-01", org: "p1", card: "1234567812345678", testMode, remind: { on: true, mode: "after", after: 1, times: ["12:00"], quiet: { from: "22:00", to: "09:00" }, every: 1, max: 3 } },
    players: NAMES.map((n, i) => ({ id: "p" + (i + 1), name: n, active: i < 12 })),
    games: [],
  };
}
// у всіх є бот, окрім Дани (p5)
const allChats = () => Object.fromEntries(NAMES.map((n, i) => "p" + (i + 1)).filter((p) => p !== "p5").map((p) => [p, { id: chat(p), u: "" }]));

const SECRET = "s3cr3t", TGT = "123456:TG-TOKEN", GHT = "github_pat_WORKER";
const env = { TG_TOKEN: TGT, GH_TOKEN: GHT, TG_SECRET: SECRET, GH_REPO: "Stock3/football", GH_BRANCH: "main", SITE_ORIGIN: "https://stock3.github.io" };
function mockWorld({ data = fixture(), tg = { chats: allChats() } } = {}) {
  const w = { files: { "data.json": JSON.stringify(data), "index.html": HTML, "tg.json": JSON.stringify(tg) }, sha: 1, dsha: 1, sent: [], tgCalls: [], mid: 500 };
  const enc = (s) => Buffer.from(s, "utf8").toString("base64");
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url); const body = opt.body ? JSON.parse(opt.body) : null;
    const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.telegram.org/bot")) {
      const method = url.split("/").pop(); w.tgCalls.push({ method, body });
      if (method === "sendMessage") { w.sent.push(body); return res(200, { ok: true, result: { message_id: ++w.mid } }); }
      return res(200, { ok: true, result: true });
    }
    if (url.startsWith("https://api.open-meteo.com/")) return res(500, {});
    const cm = url.match(/^https:\/\/api\.github\.com\/repos\/Stock3\/football\/contents\/([^?]+)/);
    if (cm) {
      const f = cm[1];
      const cur = () => (f === "tg.json" ? "sha" + w.sha : f === "data.json" ? "d" + w.dsha : "x");
      if (!opt.method || opt.method === "GET") return f in w.files ? res(200, { content: enc(w.files[f]), sha: cur() }) : res(404, {});
      if (body.sha !== cur()) return res(409, { message: "conflict" });
      w.files[f] = Buffer.from(body.content, "base64").toString("utf8");
      if (f === "tg.json") w.sha++; else if (f === "data.json") w.dsha++;
      return res(200, { content: { sha: cur() } });
    }
    if (url === "https://api.github.com/repos/Stock3/football") return res(200, { permissions: { push: true } });
    throw new Error("Неочікуваний запит " + url);
  };
  return w;
}
const tgState = (w) => JSON.parse(w.files["tg.json"]);
const dataState = (w) => JSON.parse(w.files["data.json"]);
const setData = (w, f) => { const d = dataState(w); f(d); w.files["data.json"] = JSON.stringify(d); w.dsha++; };
const game = (w) => dataState(w).games.find((g) => g.id === GID);
const quiet = async (fn) => { const orig = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = orig; } };
const clock = (t, d) => t.mock.timers.enable({ apis: ["Date"], now: d });

async function hook(body) {
  const waits = [];
  const r = await worker.fetch(new Request("https://bot.example/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return r;
}
const msgOf = (text, from = ADMIN) => ({ text, chat: { id: from, type: "private" }, from: { username: "" } });
const say = (text, from = ADMIN) => quiet(() => hook({ message: msgOf(text, from) }));
let cbn = 0;
const press = (data, from = ADMIN, mid = 9) => quiet(() => hook({ callback_query: { id: "cb" + ++cbn, from: { id: from }, data, message: { message_id: mid, chat: { id: from, type: "private" } } } }));
const notify = (b) => quiet(async () => { const r = await worker.fetch(new Request("https://bot.example/notify", { method: "POST", headers: { Origin: env.SITE_ORIGIN, Authorization: "Bearer owner-token" }, body: JSON.stringify(b) }), env, { waitUntil() {} }); return r.json(); });
const cron = () => quiet(async () => { const waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); });
// кнопка під перенаправленим повідомленням для гравця
const btns = (w, name) => (w.sent.filter((m) => m.text.startsWith("👤 для " + name) && m.reply_markup).at(-1) || { reply_markup: { inline_keyboard: [] } }).reply_markup.inline_keyboard.flat();
const btn = (w, name, label) => (btns(w, name).find((b) => b.text.includes(label)) || {}).callback_data;
const lastTo = (w, from = 0) => w.sent.slice(from).map((m) => m.text);
const mark = (w) => w.sent.length;

// ---------- перенаправлення ----------
test("testMode: увесь сценарій — жодне повідомлення не йде нікуди, крім чату адміна", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("/poll");
  // запрошення: десятеро (Аня..Їжак); Аня — адмін (без позначки), решта — «👤 для Імʼя:»; Дана без бота — теж запрошена
  const invs = w.sent.filter((m) => m.reply_markup);
  assert.equal(invs.length, 10);
  assert.ok(invs.every((m) => m.chat_id === ADMIN));
  assert.ok(!w.sent.find((m) => m.text.startsWith("👤 для Аня")), "адміну без позначки");
  assert.ok(w.sent.some((m) => m.text.startsWith("👤 для Дана (немає бота):")), "Дана без бота — позначено");
  assert.ok(!w.sent.some((m) => /📵/.test(m.text)), "у тесті «без бота» вважається підключеним — 📵 не пишемо");
  assert.ok(btn(w, "Борис", "Буду").endsWith("|p2"), "id гравця в callback_data");

  // усі десятеро натискають «Буду» (кожен — своєю кнопкою) → набралось → «Збір є» усім
  const before = mark(w);
  await press("y|" + GID); // адмін за себе: кнопка без id гравця
  for (const n of ["Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя", "Іра", "Їжак"]) await press(btn(w, n, "Буду"));
  assert.deepEqual(game(w).c.sort(), ["p1", "p10", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
  assert.ok(tgState(w).poll.announced, "збір є");
  assert.ok(lastTo(w, before).filter((x) => /Збір є|футбол буде|кворум є/.test(x)).length >= 10, "«Збір є» кожному з десяти");

  // Борис відмовляється → усім «нас тепер 9/10» і запрошено наступного; той погоджується → знову 10 → склад усім
  let b2 = mark(w);
  await press(btn(w, "Борис", "Не зможу") || "n|" + GID + "|p2");
  assert.equal(tgState(w).poll.short, true);
  assert.ok(lastTo(w, b2).some((x) => /^👤 для Йосип:/.test(x)), "наступний із черги запрошений");
  await press(btn(w, "Йосип", "Буду"));
  assert.equal(tgState(w).poll.short, false);
  assert.equal(game(w).c.length, 10);

  // скасування гри, кнопки сайту
  await notify({ mode: "cancel", game: GID });
  // рахунок і оплата (сайт зберіг data.json) → підсумок гри й подяка
  t.mock.timers.setTime(FRI_EVE.getTime());
  setData(w, (d) => { const g = d.games.find((x) => x.id === GID); const ids = g.c; g.y = ids.slice(0, 5); g.b = ids.slice(5); g.c = []; g.sy = 3; g.sb = 2; g.paid = ["p3", "p2"]; });
  const b3 = mark(w);
  const j = await notify({ mode: "played", game: GID });
  assert.ok(j.ok);
  assert.ok(lastTo(w, b3).some((x) => /^👤 для Вова:/.test(x) && /3:2|2:3/.test(x)), "підсумок гри Вові");
  // нагадування за розкладом: наступного дня о 12:00 — лише неоплатившим, усім у чат адміна
  t.mock.timers.setTime(SAT_NOON.getTime());
  const b4 = mark(w);
  await cron();
  assert.ok(lastTo(w, b4).some((x) => /нагадую|бухгалтерія|борг/.test(x) && x.startsWith("👤 для ")), "нагадування боржникам");

  assert.ok(w.sent.length > 40);
  const strays = w.sent.filter((m) => m.chat_id !== ADMIN);
  assert.deepEqual(strays, [], "жодного повідомлення поза чатом адміна");
  for (const c of w.tgCalls.filter((x) => x.method === "editMessageText")) assert.equal(c.body.chat_id, ADMIN);
});

test("testMode: кнопка в перенаправленому повідомленні діє від імені гравця; редагування лишає позначку й кнопки гравця", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("/poll");
  const yes = btn(w, "Борис", "Буду");
  assert.equal(yes, "y|" + GID + "|p2");
  await press(yes, ADMIN, 77);
  const g = game(w);
  assert.deepEqual(g.c, ["p2"], "у складі Борис, а не адмін");
  assert.equal(tgState(w).poll.inv.p2.ans, "yes");
  assert.equal(tgState(w).poll.inv.p1.ans, null);
  const ed = w.tgCalls.filter((x) => x.method === "editMessageText").at(-1).body;
  assert.equal(ed.chat_id, ADMIN); assert.equal(ed.message_id, 77);
  assert.equal(ed.text, "👤 для Борис:\nТи в грі ✅ (1/10)");
  const again = ed.reply_markup.inline_keyboard.flat().find((b) => /Передумав/.test(b.text));
  assert.equal(again.callback_data, "c|" + GID + "|p2");
  // «Передумав» → Борис виходить зі складу
  await press(again.callback_data, ADMIN, 77);
  assert.deepEqual(game(w).c, []);
  assert.equal(tgState(w).poll.inv.p2.ans, "no");
  assert.ok(w.sent.every((m) => m.chat_id === ADMIN));
  // адмін за себе — кнопка без id
  await press("y|" + GID);
  assert.deepEqual(game(w).c, ["p1"]);
});

test("testMode: Дана без бота — вважається підключеною, але в повідомленні сказано, що бота немає", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("/poll");
  await press(btn(w, "Дана", "Буду"));
  assert.deepEqual(game(w).c, ["p5"]);
  const m = w.sent.filter((x) => x.text.startsWith("👤 для Дана")).at(-1);
  assert.match(m.text, /^👤 для Дана \(немає бота\):\n/);
  assert.equal(tgState(w).poll.inv.p5.nobot, undefined);
});

// ---------- /as ----------
test("/as: /out з причиною, /who, текст-кнопка; неоднозначне імʼя, невідоме імʼя, заборонені команди", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("/poll");
  await say("/as Борис /who"); // ще нікого немає
  assert.match(w.sent.at(-1).text, /^👤 для Борис:\n⚽ П.{0,3}ятниця, 13 листопада, 21:00 — 0\/10/);
  await press(btn(w, "Борис", "Буду"));
  await say("/as борис /out"); // імʼя без урахування регістру
  assert.equal(w.sent.at(-1).chat_id, ADMIN);
  assert.equal(w.sent.at(-1).text, "👤 для Борис:\n" + DEF.say.askReason);
  assert.ok(tgState(w).poll.wait.p2);
  await say("/as Бор захворів"); // унікальний початок; наступне повідомлення — причина
  assert.deepEqual(game(w).c, []);
  assert.equal(tgState(w).poll.inv.p2.reason, "захворів");
  assert.ok(w.sent.some((m) => m.text === "👤 для Борис:\n" + DEF.say.outOk));
  assert.ok(w.sent.some((m) => /🚫 Борис скасував: захворів/.test(m.text) && !m.text.startsWith("👤")), "звіт адміну — без змін");
  // текст, схожий на кнопку («Не зможу»), і /who для гравця без бота
  await press(btn(w, "Вова", "Буду"));
  await say("/as Вова Не зможу");
  assert.match(w.sent.at(-1).text, /^👤 для Вова:\nЩо сталося/);
  await say("/as Дана /who");
  assert.match(w.sent.at(-1).text, /^👤 для Дана \(немає бота\):\n⚽/);
  // неоднозначно: Борис і Богдан
  await say("/as Б /out");
  assert.match(w.sent.at(-1).text, /Кілька збігів: Борис, Богдан/);
  await say("/as Ніхто /out");
  assert.match(w.sent.at(-1).text, /Не знайшов гравця «Ніхто»/);
  await say("/as Борис");
  assert.match(w.sent.at(-1).text, /Напиши так: \/as/);
  // /start і /stop через /as не працюють (це змінило б реальне підключення)
  const tg0 = JSON.stringify(tgState(w).chats);
  await say("/as Борис /stop");
  assert.match(w.sent.at(-1).text, /не працює через \/as/);
  assert.equal(JSON.stringify(tgState(w).chats), tg0);
  assert.ok(w.sent.every((m) => m.chat_id === ADMIN));
});

test("/as лише для адміна: гравець у режимі тесту не отримує нічого й нічого не змінює; без режиму тесту — відмова", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("/poll");
  const n = mark(w), tg0 = w.files["tg.json"], d0 = w.files["data.json"];
  await say("/as Аня /poll", chat("p2")); // Борис
  await say("/status", chat("p2"));
  await say("/who", chat("p3"));
  await press("y|" + GID, chat("p2"));
  assert.equal(mark(w), n, "жодного нового повідомлення");
  assert.equal(w.files["tg.json"], tg0); assert.equal(w.files["data.json"], d0);
  assert.equal(w.tgCalls.filter((x) => x.method === "answerCallbackQuery").at(-1).body.text, "Бот зараз на тестуванні 🛠");
  assert.ok(w.tgCalls.filter((x) => x.method === "editMessageText").length === 0);

  // режим тесту вимкнено: /as від гравця — «лише для організатора», від адміна — підказка
  const w2 = mockWorld({ data: fixture(false) });
  await say("/as Аня /who", chat("p2"));
  assert.equal(w2.sent.at(-1).chat_id, chat("p2"));
  assert.equal(w2.sent.at(-1).text, DEF.say.adminOnly);
  await say("/as Борис /who");
  assert.match(w2.sent.at(-1).text, /^Режим тесту вимкнено/);
  assert.equal(w2.sent.at(-1).chat_id, ADMIN);
});

// ---------- /testreset ----------
test("/testreset: чистить опитування й прапорці надсилання тестової гри, data.json не чіпає; без режиму тесту — відмова", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("/poll");
  await press(btn(w, "Борис", "Буду"));
  // прапорці надсилання: подяка за оплату наперед
  setData(w, (d) => { d.games.find((x) => x.id === GID).paid = ["p2"]; });
  await notify({ mode: "thanks" });
  assert.ok(tgState(w).sent[GID].p2.thx, "прапорець подяки стоїть");
  const dBefore = w.files["data.json"];
  await say("/testreset");
  const tg = tgState(w);
  assert.equal(tg.poll, undefined);
  assert.equal(tg.sent[GID], undefined);
  assert.deepEqual(Object.keys(tg.chats).length, 12, "підключення гравців не чіпаємо");
  assert.equal(w.files["data.json"], dBefore, "data.json без змін (чернетку гри видаляє власник на сайті)");
  assert.match(w.sent.at(-1).text, /🧹 Тест скинуто/);
  // після скидання можна почати заново
  await say("/poll");
  assert.equal(tgState(w).poll.open, true);

  const w2 = mockWorld({ data: fixture(false) });
  await say("/testreset");
  assert.match(w2.sent.at(-1).text, /^Режим тесту вимкнено/);
  await say("/testreset", chat("p2"));
  assert.equal(w2.sent.at(-1).text, DEF.say.adminOnly);
});

// ---------- охоплення шляхів відправки ----------
test("testMode: подяки, підсумок гри, нагадування — лише тестова гра, лише адміну; прапорці реальних ігор не палимо", async (t) => {
  clock(t, SAT_NOON);
  const data = fixture();
  data.games = [
    { id: "g20261106", date: "2026-11-06", y: ["p2", "p3"], b: ["p4", "p6"], gy: 0, gb: 0, sy: 4, sb: 1, paid: ["p3"] }, // реальна давня гра
    { id: GID, date: "2026-11-13", y: ["p2", "p3"], b: ["p4", "p5"], gy: 0, gb: 0, sy: 2, sb: 2, paid: ["p3"] }, // тестова
  ];
  const tg = { chats: allChats(), poll: { game: GID, open: false, startedAt: "x", closedAt: "y", announced: null, short: false, queueFront: [], inv: {} } };
  const w = mockWorld({ data, tg });
  await cron();
  const texts = lastTo(w);
  assert.ok(texts.length > 0);
  assert.ok(w.sent.every((m) => m.chat_id === ADMIN));
  const st = tgState(w);
  assert.equal(st.sent.g20261106, undefined, "реальна гра: прапорці не чіпали");
  assert.ok(st.sent[GID], "тестова гра: прапорці стоять");
  assert.deepEqual(st.slots, [], "слот розкладу не «спалено»");
  assert.ok(w.sent.some((m) => m.text.startsWith("👤 для Дана (немає бота):")), "підсумок гри гравцю без бота — адміну, з позначкою");
  const n = mark(w);
  await cron(); // повторний cron — нічого нового (прапорці працюють)
  assert.equal(mark(w), n);
});

test("testMode без підключеного адміна: бот мовчить повністю", async (t) => {
  clock(t, THU);
  const chats = allChats(); delete chats.p1;
  const w = mockWorld({ tg: { chats } });
  await say("/poll");
  await say("/poll", chat("p2"));
  await cron();
  await notify({ mode: "gather", game: "nope" });
  assert.deepEqual(w.sent, []);
});

test("testMode вимкнено: усе як раніше — реальним гравцям, без позначок і без id гравця в кнопках", async (t) => {
  clock(t, THU);
  const w = mockWorld({ data: fixture(false) });
  await say("/poll");
  const invs = w.sent.filter((m) => m.reply_markup);
  assert.deepEqual(invs.map((m) => m.chat_id).sort(), [101, 102, 103, 104, 106, 107, 108, 109, 110].sort()); // без Дани: бота немає
  assert.ok(w.sent.every((m) => !m.text.startsWith("👤")));
  assert.ok(invs.every((m) => m.reply_markup.inline_keyboard.flat().every((b) => b.callback_data.split("|").length === 2)));
  assert.ok(w.sent.some((m) => m.chat_id === ADMIN && /📵 Дана без бота/.test(m.text)));
  // кнопка Бориса — від Бориса
  await press("y|" + GID, chat("p2"), 5);
  assert.deepEqual(game(w).c, ["p2"]);
  assert.equal(w.tgCalls.filter((x) => x.method === "editMessageText").at(-1).body.chat_id, chat("p2"));
  // реальний гравець у звичайному режимі отримує відповіді
  await say("/who", chat("p3"));
  assert.equal(w.sent.at(-1).chat_id, chat("p3"));
});
