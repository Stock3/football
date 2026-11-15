// Тести кнопок внизу чату (постійна клавіатура), меню адміна й розсилки: core.js — чисті функції, index.js — з моками Telegram і GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import worker from "../src/index.js";
import { initGit } from "./gh-mock.mjs";

Math.random = () => 0;
const dir = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8");
const DEF = core.parseDef(HTML);
const THU = new Date("2026-11-12T09:00:00Z"); // четвер, 11:00 у Києві; гра — пʼятниця 13 листопада
const LATE = new Date("2026-11-12T21:30:00Z"); // четвер, 23:30 — тихі години (22:00–09:00)
const GID = "g20261113";
const ADMIN = 101;
const NAMES = ["Аня", "Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя", "Іра", "Їжак", "Йосип", "Кіра", "Богдан"];
const KC = { S: { bank: "https://send.monobank.ua/jar/abc" } }; // контекст для клавіатури внизу (web_app-кнопка поповнення)
const chat = (pid) => 100 + +pid.slice(1);
// у всіх є бот, окрім Дани (p5); Богдан (p13) — неактивний, але підключений
const allChats = () => Object.fromEntries(NAMES.map((n, i) => "p" + (i + 1)).filter((p) => p !== "p5").map((p) => [p, { id: chat(p), u: "" }]));
function fixture(o = {}) {
  return {
    v: 1,
    settings: { payFrom: "2026-11-01", org: "p1", bank: "https://send.monobank.ua/jar/abc", testMode: !!o.testMode, poll: o.need ? { need: o.need } : undefined, remind: { on: true, mode: "after", after: 1, times: ["12:00"], quiet: { from: "22:00", to: "09:00" }, every: 1, max: 3 } },
    players: NAMES.map((n, i) => ({ id: "p" + (i + 1), name: n, active: i < 12 })),
    games: o.games || [],
  };
}
const draft = (c) => [{ id: GID, date: "2026-11-13", c, y: [], b: [], gy: 0, gb: 0 }];

const SECRET = "s3cr3t", env = { TG_TOKEN: "123456:TG-TOKEN", GH_TOKEN: "github_pat_WORKER", TG_SECRET: SECRET, GH_REPO: "Stock3/football", GH_BRANCH: "main", SITE_ORIGIN: "https://stock3.github.io" };
function mockWorld({ data = fixture(), tg = { chats: allChats() } } = {}) {
  const w = { files: { "data.json": JSON.stringify(data), "index.html": HTML, "tg.json": JSON.stringify(tg) }, sent: [], tgCalls: [], mid: 500 };
  const gh = initGit(w);
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url); const body = opt.body ? JSON.parse(opt.body) : null;
    const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.telegram.org/bot")) {
      const method = url.split("/").pop(); w.tgCalls.push({ method, body });
      if (method === "sendMessage") { w.sent.push(body); return res(200, { ok: true, result: { message_id: ++w.mid } }); }
      return res(200, { ok: true, result: true });
    }
    if (url.startsWith("https://api.open-meteo.com/")) return res(500, {});
    const r = gh(url, opt, body, res);
    if (r) return r;
    throw new Error("Неочікуваний запит " + url);
  };
  return w;
}
const tgState = (w) => JSON.parse(w.files["tg.json"]);
const dataState = (w) => JSON.parse(w.files["data.json"]);
const quiet = async (fn) => { const orig = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = orig; } };
const clock = (t, d) => t.mock.timers.enable({ apis: ["Date"], now: d });
async function hook(body) {
  const waits = [];
  await worker.fetch(new Request("https://bot.example/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
const say = (text, from = ADMIN, username = "") => quiet(() => hook({ message: { text, chat: { id: from, type: "private" }, from: { username } } }));
let cbn = 0;
const press = (data, from = ADMIN, mid = 9) => quiet(() => hook({ callback_query: { id: "cb" + ++cbn, from: { id: from }, data, message: { message_id: mid, chat: { id: from, type: "private" } } } }));
const last = (w) => w.sent.at(-1);
const labels = (kb) => kb.inline_keyboard.flat().map((b) => b.text);
const edits = (w) => w.tgCalls.filter((c) => c.method === "editMessageText").map((c) => c.body);
const answers = (w) => w.tgCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body);
const to = (w, chatId, from = 0) => w.sent.slice(from).filter((m) => m.chat_id === chatId);
const pvId = (w) => last(w).reply_markup.inline_keyboard[0][0].callback_data;

// ---------- core: таблиця кнопок ----------
const C0 = (o = {}) => core.context({ data: o.data || fixture(), DEF, tg: o.tg || { chats: allChats() }, now: o.now || THU, site: "https://stock3.github.io/football/", rand: () => 0 });
const pm = (text, chatId = 102, username = "") => ({ text, chat: { id: chatId, type: "private" }, from: { username } });
const strip = (r) => JSON.stringify({ msgs: r.msgs, ops: r.ops, poll: r.poll, weather: r.weather });

test("кнопка внизу = та сама команда: одна таблиця, однаковий результат (з емодзі-селектором і без)", () => {
  const C = C0();
  const table = { "✅ Хочу грати": "/in", "❌ Не зможу": "/out", "👥 Хто йде": "/who", "🌦 Погода": "/weather", "💰 Баланс": "/balance", "💳 Поповнити": "/topup", "🔕 Відписатися": "/stop", "📊 Статистика": "/stats" };
  for (const [btn, cmd] of Object.entries(table)) {
    assert.equal(strip(core.onMessage(C, pm(btn))), strip(core.onMessage(C, pm(cmd))), btn);
    assert.equal(strip(core.onMessage(C, pm(btn.replace(" ", "️ ")))), strip(core.onMessage(C, pm(cmd))), btn + " з селектором");
  }
  assert.equal(strip(core.onMessage(C, pm("⚙️ Адмін", ADMIN))), strip(core.onMessage(C, pm("/admin", ADMIN))));
  assert.equal(strip(core.onMessage(C, pm("⚙ Адмін", ADMIN))), strip(core.onMessage(C, pm("/admin", ADMIN))), "без селектора");
  // кнопки справді доходять до своїх обробників
  assert.equal(core.onMessage(C, pm("✅ Хочу грати")).poll.t, "in");
  assert.equal(core.onMessage(C, pm("❌ Не зможу")).poll.t, "ask");
  assert.equal(core.onMessage(C, pm("👥 Хто йде")).poll.t, "who");
  assert.ok(core.onMessage(C, pm("🌦 Погода")).weather);
  assert.match(core.onMessage(C, pm("💰 Баланс")).msgs[0].text, /^💰 Баланс: /);
  assert.equal(core.onMessage(C, pm("💳 Поповнити")).msgs[0].kb.inline_keyboard[0][0].text, "💳 Поповнити");
  assert.deepEqual(core.onMessage(C, pm("🔕 Відписатися")).ops, [{ op: "unlink", pid: "p2" }]);
  // невідомому — підказка, як і для команд
  assert.match(core.onMessage(C, pm("✅ Хочу грати", 999)).msgs[0].text, /Я тебе ще не знаю/);
  // команди й текст без кнопок працюють як раніше
  assert.equal(core.onMessage(C, pm("/in")).poll.t, "in");
  assert.equal(core.onMessage(C, pm("хочу грати")).poll.t, "in");
});

test("/start: гравець — клавіатура 4 рядки без «Відписатися»; організатор — те саме + «⚙️ Адмін»; постійна й підганяється; /stop її прибирає", () => {
  const C = C0({ tg: {} });
  const rows = (r) => r.msgs[0].kb.keyboard.map((x) => x.map((b) => b.text));
  const p = core.onMessage(C, pm("/start p2", 555));
  assert.deepEqual(rows(p), [["✅ Хочу грати", "❌ Не зможу"], ["👥 Хто йде", "🌦 Погода"], ["💰 Баланс", "💳 Поповнити"], ["📊 Статистика"]]);
  assert.ok(!p.msgs[0].kb.is_persistent);
  assert.equal(p.msgs[0].kb.resize_keyboard, true);
  assert.match(p.msgs[0].text, /Привіт, Борис!/);
  const a = core.onMessage(C, pm("/start p1", 556));
  assert.deepEqual(rows(a), [["✅ Хочу грати", "❌ Не зможу"], ["👥 Хто йде", "🌦 Погода"], ["💰 Баланс", "💳 Поповнити"], ["📊 Статистика"], ["⚙️ Адмін"]]);
  // повторний /start уже підключеного — клавіатуру надсилає знову
  assert.ok(core.onMessage(C0(), pm("/start p2", 102)).msgs[0].kb.keyboard);
  assert.deepEqual(core.onMessage(C0(), pm("/stop", 102)).msgs[0].kb, { remove_keyboard: true });
  // відмова підключення — без клавіатури
  assert.equal(core.onMessage(C, pm("/start p99")).msgs[0].kb, undefined);
});

// ---------- кнопки через бота ----------
test("/start через бота: клавіатура йде в reply_markup привітання (адміну — з «⚙️ Адмін»)", async (t) => {
  clock(t, THU);
  const w = mockWorld({ tg: {} });
  await say("/start p1", 555);
  assert.equal(last(w).chat_id, 555);
  assert.ok(!last(w).reply_markup.is_persistent);
  assert.ok(last(w).reply_markup.keyboard.flat().some((b) => b.text === "⚙️ Адмін"));
  assert.equal(tgState(w).chats.p1.id, 555);
  await say("/start p2", 556);
  assert.ok(!last(w).reply_markup.keyboard.flat().some((b) => b.text === "⚙️ Адмін"));
});

test("«✅ Хочу грати» / «❌ Не зможу»: відповідь за станом, причина наступним повідомленням", async (t) => {
  clock(t, THU);
  const w = mockWorld({ data: fixture({ need: 20, games: draft(["p2"]) }) }); // місць вистачає всім: повернення без черги
  await say("/poll");
  // Богдан (неактивний) не запрошений і не в грі: «Не зможе» → «Тебе й так немає в списку»
  await say("❌ Не зможу", chat("p13"));
  assert.equal(last(w).text, "Тебе й так немає в списку");
  // Борис у грі: «Хочу грати» → «Ти в грі»
  await say("✅ Хочу грати", 102);
  assert.match(last(w).text, /^Ти в грі ✅ \(\d+\/20\)$/);
  // «Не зможе» → запит причини; наступний текст — причина; гравець поза складом
  await say("❌ Не зможу", 102);
  assert.match(last(w).text, /Що сталося/);
  assert.ok(tgState(w).poll.wait.p2);
  await say("болить спина", 102);
  assert.deepEqual(dataState(w).games[0].c, []);
  assert.equal(tgState(w).poll.inv.p2.reason, "болить спина");
  assert.equal(tgState(w).poll.wait, undefined);
  // вдруге «Не зможе» — «й так немає», «Хочу грати» — повертає
  await say("❌ Не зможу", 102);
  assert.equal(last(w).text, "Тебе й так немає в списку");
  await say("✅ Хочу грати", 102);
  assert.deepEqual(dataState(w).games[0].c, ["p2"]);
});

test("кнопки «👥 Хто йде», «💰 Баланс», «💳 Поповнити» через бота", async (t) => {
  clock(t, THU);
  const w = mockWorld({ data: fixture({ games: draft(["p2", "p3"]) }) });
  await say("👥 Хто йде", 102);
  assert.match(last(w).text, /Буде \(2\): Борис, Вова/);
  await say("💰 Баланс", 102);
  assert.match(last(w).text, /^💰 Баланс: 0 грн/);
  await say("💳 Поповнити", 102);
  assert.equal(last(w).reply_markup.inline_keyboard[0][0].url, "https://send.monobank.ua/jar/abc");
});

// ---------- адмін: гарди ----------
test("адмін-функції лише для організатора: кнопка, меню, розсилка, текст розсилки", async (t) => {
  clock(t, THU);
  const w = mockWorld({ data: fixture({ games: draft(["p2"]) }) });
  const ADM = DEF.say.adminOnly;
  await say("⚙️ Адмін", 102);
  assert.equal(last(w).text, ADM);
  assert.equal(last(w).reply_markup, undefined);
  await say("/admin", 102);
  assert.equal(last(w).text, ADM);
  const c0 = w.commits.length;
  for (const d of ["adm:menu", "adm:poll", "adm:end", "adm:no", "adm:no:p2", "adm:bc", "bc:all", "bc:game", "bc:ok:x", "bc:x"]) {
    await press(d, 102);
    assert.equal(answers(w).at(-1).text, ADM, d);
  }
  assert.equal(w.commits.length, c0, "жодних змін стану");
  assert.equal(edits(w).length, 0);
  // /cancel не-адміна — нічого; текст не-адміна розсилкою не стає, навіть коли в адміна розсилка готується
  await say("/cancel", 102);
  assert.match(last(w).text, /Нічого скасовувати/);
  await press("adm:bc"); await press("bc:all");
  assert.equal(tgState(w).bc.step, "text");
  await say("привіт усім", 102);
  assert.match(last(w).text, /Я вмію/);
  assert.equal(tgState(w).bc.step, "text");
  assert.equal(to(w, ADMIN).filter((m) => /Отримають/.test(m.text)).length, 0);
});

// ---------- адмін-меню ----------
test("«⚙️ Адмін» → інлайн-меню; «Почати/Закрити опитування»", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await say("⚙️ Адмін");
  assert.equal(last(w).chat_id, ADMIN);
  assert.deepEqual(labels(last(w).reply_markup), ["Почати опитування", "Закрити опитування", "Не зможе", "📣 Розсилка"]);
  await press("adm:poll");
  assert.equal(tgState(w).poll.open, true);
  assert.equal(dataState(w).games[0].id, GID);
  assert.ok(w.sent.some((m) => m.chat_id === ADMIN && /Опитування на 13 листопада/.test(m.text)), "організатору — звіт про запуск");
  assert.ok(w.sent.some((m) => m.chat_id === chat("p3") && m.reply_markup), "запрошення розіслано");
  await press("adm:poll");
  assert.ok(w.sent.some((m) => /Опитування вже йде/.test(m.text)));
  await press("adm:end");
  assert.equal(tgState(w).poll.open, false);
  assert.ok(w.sent.some((m) => /Опитування закрито/.test(m.text)));
});

test("меню адміна → «Не зможе»: список гравців гри, вибір = /no Імʼя", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await press("adm:no");
  assert.equal(answers(w).at(-1).text, "Опитування зараз не йде");
  await say("/poll");
  for (const p of ["p2", "p3"]) await press("y|" + GID, chat(p));
  await press("adm:no", ADMIN, 33);
  const e = edits(w).at(-1);
  assert.equal(e.message_id, 33);
  assert.match(e.text, /Хто не зможе/);
  assert.deepEqual(labels(e.reply_markup), ["Борис", "Вова", "← Назад"]);
  const pick = e.reply_markup.inline_keyboard.flat().find((b) => b.text === "Борис").callback_data;
  assert.equal(pick, "adm:no:p2");
  const from = w.sent.length;
  await press(pick, ADMIN, 33);
  assert.deepEqual(dataState(w).games[0].c, ["p3"]);
  assert.equal(tgState(w).poll.inv.p2.ans, "no");
  assert.ok(to(w, ADMIN, from).some((m) => m.text.includes("Борис скасував (відмітив організатор)")));
  assert.deepEqual(labels(edits(w).at(-1).reply_markup), ["Вова", "← Назад"]);
  assert.match(edits(w).at(-1).text, /Борис — відмічено/);
  // Борис уже не в грі
  await press(pick, ADMIN, 33);
  assert.equal(answers(w).at(-1).text, "Уже не в грі");
  await press("adm:menu", ADMIN, 33);
  assert.equal(edits(w).at(-1).text, "⚙️ Адмін");
});

// ---------- розсилка ----------
test("розсилка «Усім підключеним»: Кому? → текст → перегляд → надіслати; тихі години не діють", async (t) => {
  clock(t, LATE);
  const w = mockWorld();
  await say("⚙️ Адмін");
  await press("adm:bc", ADMIN, 21);
  const q = edits(w).at(-1);
  assert.match(q.text, /Кому/);
  assert.deepEqual(labels(q.reply_markup), ["Усім підключеним", "Учасникам гри", "Скасувати"]);
  await press("bc:all", ADMIN, 21);
  assert.match(edits(w).at(-1).text, /Надішли текст/);
  assert.equal(tgState(w).bc.step, "text");
  assert.equal(tgState(w).bc.aud, "all");
  await say("Завтра гра на 20:00, не запізнюйтесь!");
  const pv = last(w);
  assert.equal(pv.chat_id, ADMIN);
  assert.match(pv.text, /Завтра гра на 20:00, не запізнюйтесь!/);
  // підключені: всі, окрім Дани (немає бота); Богдан — неактивний, але підключений
  assert.match(pv.text, /Отримають 12: Аня, Борис, Вова, Гліб, Еля, Женя, Зоя, Іра, Їжак, Йосип, Кіра, Богдан/);
  assert.deepEqual(labels(pv.reply_markup), ["📤 Надіслати", "Скасувати"]);
  assert.equal(tgState(w).bc.step, "preview");
  const before = w.sent.length;
  await press(pvId(w), ADMIN, 22);
  const got = w.sent.slice(before).filter((m) => m.text === "Завтра гра на 20:00, не запізнюйтесь!");
  assert.equal(got.length, 12);
  assert.deepEqual(got.map((m) => m.chat_id).sort(), Object.values(allChats()).map((c) => c.id).sort());
  assert.ok(!got.some((m) => m.chat_id === chat("p5")));
  assert.equal(tgState(w).bc, undefined, "стан розсилки прибрано");
  assert.match(edits(w).at(-1).text, /Розсилку надіслано: 12/);
  // повторне натискання — вже неактуально, удруге не шле
  await press("bc:ok:x", ADMIN, 22);
  assert.equal(answers(w).at(-1).text, "Уже неактуально");
  assert.equal(w.sent.length, before + 12);
});

test("розсилка несе клавіатуру внизу: гравцю — гравця, організатору — з «⚙️ Адмін»", async (t) => {
  clock(t, LATE);
  const w = mockWorld();
  await press("adm:bc", ADMIN, 21); await press("bc:all", ADMIN, 21);
  await say("Текст розсилки");
  const before = w.sent.length;
  await press(pvId(w), ADMIN, 22);
  const got = w.sent.slice(before).filter((m) => m.text === "Текст розсилки");
  const flat = (m) => m.reply_markup.keyboard.flat().map((b) => b.text);
  const player = got.find((m) => m.chat_id === chat("p2"));
  assert.deepEqual(player.reply_markup, core.mainKb(false, KC));
  assert.ok(!flat(player).includes("⚙️ Адмін"));
  const org = got.find((m) => m.chat_id === ADMIN);
  assert.deepEqual(org.reply_markup, core.mainKb(true, KC));
  assert.ok(flat(org).includes("⚙️ Адмін"));
  assert.ok(got.every((m) => m.reply_markup && m.reply_markup.keyboard && !m.reply_markup.is_persistent));
});

test("розсилка в режимі тесту: усе в чат адміна, і клавіатура — адмінська", async (t) => {
  clock(t, LATE);
  const w = mockWorld({ data: fixture({ testMode: true }) });
  await press("adm:bc", ADMIN, 21); await press("bc:all", ADMIN, 21);
  await say("Тестова розсилка");
  const before = w.sent.length;
  await press(pvId(w), ADMIN, 22);
  const got = w.sent.slice(before).filter((m) => m.text.includes("Тестова розсилка"));
  assert.ok(got.length > 1);
  for (const m of got) {
    assert.equal(m.chat_id, ADMIN);
    assert.deepEqual(m.reply_markup, core.mainKb(true, KC));
  }
  assert.ok(got.some((m) => m.text.startsWith("👤 для ")));
});

test("розсилка «Учасникам гри»: c/y/b поточної гри; без бота — у перегляді, не отримують; порожня гра — не починається", async (t) => {
  clock(t, THU);
  const data = fixture({ games: [{ id: GID, date: "2026-11-13", c: ["p3"], y: ["p2", "p5"], b: ["p4"], gy: 1, gb: 0 }] });
  const w = mockWorld({ data });
  await press("adm:bc"); await press("bc:game");
  assert.equal(tgState(w).bc.aud, "game");
  await say("Беремо жовті й сині футболки");
  assert.match(last(w).text, /Учасникам гри/);
  assert.match(last(w).text, /Отримають 3: Вова, Борис, Гліб/);
  assert.match(last(w).text, /Без бота \(не отримають\): Дана/);
  const before = w.sent.length;
  await press(pvId(w));
  const got = w.sent.slice(before).filter((m) => m.text === "Беремо жовті й сині футболки").map((m) => m.chat_id).sort();
  assert.deepEqual(got, [chat("p2"), chat("p3"), chat("p4")].sort());
  // гри немає / у ній нікого — розсилка не починається
  const w2 = mockWorld({ data: fixture({ games: draft([]) }) });
  await press("bc:game");
  assert.equal(answers(w2).at(-1).text, "У грі нікого немає");
  assert.equal(tgState(w2).bc, undefined);
  const w3 = mockWorld();
  await press("bc:game");
  assert.equal(answers(w3).at(-1).text, "Гри немає");
});

test("розсилка: «Скасувати» і /cancel на кожному кроці; новий текст замінює перегляд, старі кнопки неактуальні", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await press("bc:all", ADMIN, 5);
  await press("bc:x", ADMIN, 5);
  assert.equal(tgState(w).bc, undefined);
  assert.equal(edits(w).at(-1).text, "Розсилку скасовано");
  // /cancel на кроці «текст»
  await press("bc:all");
  await say("/cancel");
  assert.equal(last(w).text, "Розсилку скасовано");
  assert.equal(tgState(w).bc, undefined);
  // після /cancel текст адміна — звичайне повідомлення, не розсилка
  await say("щось");
  assert.match(last(w).text, /Я вмію/);
  // /cancel на кроці «перегляд»
  await press("bc:all"); await say("перший");
  assert.equal(tgState(w).bc.step, "preview");
  await say("/cancel");
  assert.equal(tgState(w).bc, undefined);
  // новий текст у перегляді замінює старий; кнопка старого перегляду не діє
  await press("bc:all"); await say("старий текст");
  const oldBtn = pvId(w);
  t.mock.timers.setTime(THU.getTime() + 5000);
  await say("новий текст");
  assert.match(last(w).text, /новий текст/);
  assert.notEqual(pvId(w), oldBtn);
  const before = w.sent.length;
  await press(oldBtn);
  assert.match(answers(w).at(-1).text, /застарілий перегляд/);
  assert.equal(w.sent.length, before, "стару розсилку не надіслано");
  await press(pvId(w));
  assert.equal(w.sent.slice(before).filter((m) => m.text === "новий текст").length, 12);
  assert.equal(w.sent.filter((m) => m.text === "старий текст").length, 0);
});

test("розсилка, що застрягла, живе годину: потім текст адміна — звичайне повідомлення", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await press("bc:all");
  t.mock.timers.setTime(THU.getTime() + 2 * 3600e3);
  await say("давно було");
  assert.match(last(w).text, /Я вмію/);
  assert.ok(!w.sent.some((m) => /Отримають/.test(m.text)));
  // стара кнопка «Надіслати» нічого не шле
  await press("bc:ok:abc");
  assert.equal(answers(w).at(-1).text, "Уже неактуально");
  // будь-який крок опитування прибирає протухлий стан із tg.json
  await say("/who");
  assert.equal(tgState(w).bc, undefined);
});

test("розсилка й причина /out — окремі стани: що почалось пізніше, те й забирає наступний текст; /cancel чіпає лише розсилку", async (t) => {
  clock(t, THU);
  const w = mockWorld({ data: fixture({ need: 20 }) });
  await say("/poll");
  await press("y|" + GID);
  // 1) /out, потім розсилка → текст іде в розсилку, причина лишається чекати
  await say("❌ Не зможу");
  assert.ok(tgState(w).poll.wait.p1);
  t.mock.timers.setTime(THU.getTime() + 60e3);
  await press("bc:all");
  t.mock.timers.setTime(THU.getTime() + 120e3);
  await say("текст розсилки");
  assert.equal(tgState(w).bc.step, "preview");
  assert.ok(tgState(w).poll.wait.p1, "причину /out розсилка не забрала");
  assert.deepEqual(dataState(w).games[0].c, ["p1"]);
  // /cancel прибирає лише розсилку; наступний текст — уже причина
  await say("/cancel");
  assert.equal(tgState(w).bc, undefined);
  assert.ok(tgState(w).poll.wait.p1, "/cancel не зачепив причину");
  await say("захворів");
  assert.deepEqual(dataState(w).games[0].c, []);
  assert.equal(tgState(w).poll.inv.p1.reason, "захворів");
  // 2) розсилка, потім /out → текст іде причиною, розсилка чекає
  await say("✅ Хочу грати");
  t.mock.timers.setTime(THU.getTime() + 180e3);
  await press("bc:all");
  t.mock.timers.setTime(THU.getTime() + 240e3);
  await say("❌ Не зможу");
  t.mock.timers.setTime(THU.getTime() + 300e3);
  await say("знову причина");
  assert.equal(tgState(w).poll.inv.p1.reason, "знову причина");
  assert.equal(tgState(w).bc.step, "text", "розсилка досі чекає тексту");
  // команда й кнопка не стають текстом розсилки
  await say("/who");
  assert.equal(tgState(w).bc.step, "text");
  await say("👥 Хто йде");
  assert.equal(tgState(w).bc.step, "text");
});

test("розсилка переживає інші записи tg.json (cron): стан не губиться", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await press("bc:all"); await say("текст");
  const bc = tgState(w).bc;
  const waits = [];
  await quiet(async () => { await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits); });
  assert.deepEqual(tgState(w).bc, bc);
  assert.equal(core.bcActive(core.normState(tgState(w)), THU.getTime()).step, "preview");
});

test("розсилка: недоставлені — організатору; хто відключився між переглядом і «Надіслати» — не отримує", async (t) => {
  clock(t, THU);
  const w = mockWorld();
  await press("bc:all"); await say("текст");
  const id = pvId(w);
  const tg = tgState(w); delete tg.chats.p4; w.files["tg.json"] = JSON.stringify(tg); // Гліб відключився
  // Йосип заблокував бота: Telegram відхиляє
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).endsWith("/sendMessage") && JSON.parse(opt.body).chat_id === chat("p11")) return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: 403 });
    return orig(url, opt);
  };
  const before = w.sent.length;
  await press(id);
  const got = w.sent.slice(before);
  assert.ok(!got.some((m) => m.chat_id === chat("p4")), "Гліб не отримав");
  assert.equal(got.filter((m) => m.text === "текст").length, 10, "12 − Гліб − Йосип (заблокував)");
  assert.ok(got.some((m) => m.chat_id === ADMIN && /Розсилка не дійшла: Йосип/.test(m.text)));
});

// ---------- режим тесту ----------
test("режим тесту: розсилка йде лише адміну з «👤 для Імʼя:», реальним гравцям — нічого; перегляд — активні гравці", async (t) => {
  clock(t, THU);
  const data = fixture({ testMode: true, games: [{ id: GID, date: "2026-11-13", c: ["p2", "p5"], y: [], b: [], gy: 0, gb: 0 }] });
  const w = mockWorld({ data });
  // реальний гравець у режимі тесту: ні кнопки, ні розсилка
  await say("⚙️ Адмін", 102);
  assert.ok(!w.sent.some((m) => m.chat_id === 102));
  await press("adm:bc", 102);
  assert.equal(tgState(w).bc, undefined);

  await press("bc:all"); await say("тестова розсилка");
  assert.match(last(w).text, /Отримають 12: Аня, Борис, Вова, Гліб, Дана, Еля, Женя, Зоя, Іра, Їжак, Йосип, Кіра$/m, "у тесті Дана (без бота) теж «підключена», Богдан неактивний — ні");
  const before = w.sent.length;
  await press(pvId(w));
  const got = w.sent.slice(before).filter((m) => /тестова розсилка/.test(m.text));
  assert.equal(got.length, 12);
  assert.ok(got.every((m) => m.chat_id === ADMIN), "усе — в чат адміна");
  assert.ok(got.some((m) => m.text === "👤 для Борис:\nтестова розсилка"));
  assert.ok(got.some((m) => m.text === "👤 для Дана (немає бота):\nтестова розсилка"));
  assert.ok(got.some((m) => m.text === "тестова розсилка"), "собі (адміну) — без позначки");
  assert.ok(!w.sent.slice(before).some((m) => m.chat_id !== ADMIN), "реальні чати тиші");

  // учасникам гри
  const b2 = w.sent.length;
  await press("bc:game"); await say("для складу");
  assert.match(last(w).text, /Отримають 2: Борис, Дана/);
  await press(pvId(w));
  assert.deepEqual(w.sent.slice(b2).filter((m) => /для складу$/.test(m.text)).map((m) => m.text), ["👤 для Борис:\nдля складу", "👤 для Дана (немає бота):\nдля складу"]);
  assert.ok(!w.sent.slice(b2).some((m) => m.chat_id !== ADMIN));
});

test("режим тесту: /start адміна шле клавіатуру без помилки (reply-клавіатуру тегувати не треба); кнопка-текст через /as", async (t) => {
  clock(t, THU);
  const w = mockWorld({ data: fixture({ testMode: true }) });
  await say("/start p1", ADMIN);
  assert.ok(last(w).reply_markup.keyboard, "клавіатура доставлена");
  await say("/as Борис ✅ Хочу грати");
  assert.equal(last(w).text, "👤 для Борис:\nЗараз опитування немає");
  assert.equal(last(w).chat_id, ADMIN);
});

test("кнопка «💳 Поповнити» внизу: web_app з https-банком; без банку чи не https — звичайна текстова; «Відписатися» немає", () => {
  const find = (kb) => kb.keyboard.flat().find((b) => b.text === "💳 Поповнити");
  const C = C0({ tg: {} });
  assert.deepEqual(find(core.onMessage(C, pm("/start p2", 555)).msgs[0].kb), { text: "💳 Поповнити", web_app: { url: "https://send.monobank.ua/jar/abc" } });
  assert.deepEqual(find(core.mainKb(true, C)), { text: "💳 Поповнити", web_app: { url: "https://send.monobank.ua/jar/abc" } });
  for (const bank of ["", "http://send.monobank.ua/jar/abc", "не посилання"]) {
    const C2 = C0({ tg: {} }); C2.S.bank = bank;
    assert.deepEqual(find(core.mainKb(false, C2)), { text: "💳 Поповнити" }, JSON.stringify(bank));
  }
  assert.deepEqual(find(core.mainKb(false)), { text: "💳 Поповнити" });
  assert.ok(!JSON.stringify(core.mainKb(true, C)).includes("Відписатися"));
  assert.equal(core.onMessage(C0(), pm("/stop", 102)).ops[0].op, "unlink", "/stop працює");
  assert.equal(core.onMessage(C0(), pm("💳 Поповнити", 102)).msgs.length, 1, "старий текст кнопки → /topup");
});
