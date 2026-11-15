// Статистика в боті: /stats і «📊 Статистика» → список гравців → картка (src/stats.js поверх спільного блоку ST).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.js";
import * as stats from "../src/stats.js";
import worker from "../src/index.js";
import { initGit } from "./gh-mock.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(dir, "..", "..", "index.html"), "utf8");
const DEF = core.parseDef(HTML);
const NOW = new Date("2026-11-12T09:00:00Z");
const SITE = "https://stock3.github.io/football/";
const NAMES = ["Аня", "Борис", "Вова", "Гліб", "Дана", "Еля", "Женя", "Зоя"];
const g = (date, y, b, sy, sb, x) => ({ id: "g" + date.replace(/-/g, ""), date, y, b, gy: 0, gb: 0, ...(sy != null ? { sy, sb } : {}), ...(x ? { x: true } : {}) });
const A = ["p1", "p2", "p3"], B = ["p4", "p5", "p6"];
function fixture() {
  return {
    v: 1,
    settings: { org: "p1" },
    // Женя (p7) — неактивна; Зоя (p8) — активна, але ще не грала
    players: NAMES.map((n, i) => ({ id: "p" + (i + 1), name: n, active: i !== 6, ...(i === 0 ? { num: 8 } : {}) })),
    games: [
      g("2025-05-02", A, B, 3, 1), // p1: перемога (лише «весь час»)
      g("2026-03-06", A, B, 2, 4), // p1 за жовтих: поразка
      g("2026-03-13", ["p1", "p4", "p5"], ["p2", "p3", "p6"], 5, 5), // нічия
      g("2026-03-20", B, A, 1, 3), // p1 за синіх: перемога
      g("2026-03-27", B, A, 0, 2), // перемога
      g("2026-04-03", A, B, 0, 9, true), // скасована — не рахується
      g("2027-01-08", A, B), // запланована наступного року — не відкриває порожній сезон
    ],
  };
}
const C0 = (data = fixture()) => core.context({ data, DEF, tg: { chats: { p1: { id: 101 }, p2: { id: 102 } } }, now: NOW, site: SITE, rand: () => 0 });

test("картка: сезон за замовчуванням — останній рік із зіграною грою; усі розділи", () => {
  const r = stats.card(C0(), "p1");
  assert.equal(r.text, [
    "📊 Аня · #8 · Сезон 2026",
    "Ігор 4 · 2–1–1 · 7 очок · 50% перемог",
    "Місце: 1-е з 6 за очками · 1-е за %В",
    "+/− за гру: +0.5 · відвідуваність 100%",
    "Форма: 🟥⬜🟩🟩 (серія: 2 перемоги поспіль, найдовша: 2 перемоги)",
    "🟡 За жовтих: 2 · 0–1–1 · 0%",
    "🔵 За синіх: 2 · 2–0–0 · 100%",
    "💪 Найчастіше обігрує: Гліб (2 з 3), Дана (2 з 3)",
    "🎯 Віхи: до 10-ї гри — 5, до 10-ї перемоги — 7",
    "Останні: 27.03 🔵 2:0 🟩 · 20.03 🔵 3:1 🟩 · 13.03 🟡 5:5 ⬜",
    "🔗 " + SITE + "#p1",
  ].join("\n"));
  // 😬 немає: усім суперникам Аня програвала рідше, ніж вигравала — розділ без даних не показуємо
  assert.ok(!r.text.includes("😬"));
  assert.deepEqual(r.kb.inline_keyboard.map((row) => row.map((b) => [b.text, b.callback_data])), [
    [["2025", "st:p1:2025"], ["• 2026", "st:p1:2026"], ["Весь час", "st:p1:all"]],
    [["← Інший гравець", "st:l"]],
  ]);
});

test("картка: весь час проти сезону", () => {
  const all = stats.card(C0(), "p1", "all").text.split("\n");
  assert.equal(all[0], "📊 Аня · #8 · Весь час");
  assert.equal(all[1], "Ігор 5 · 3–1–1 · 10 очок · 60% перемог");
  assert.ok(all[4].startsWith("Форма: 🟩🟥⬜🟩🟩 "), all[4]); // останні 5 — разом із грою 2025 року
  const y25 = stats.card(C0(), "p1", "2025").text.split("\n");
  assert.equal(y25[0], "📊 Аня · #8 · Сезон 2025");
  assert.equal(y25[1], "Ігор 1 · 1–0–0 · 3 очки · 100% перемог");
  assert.equal(y25[2], "Місце: 1-е з 6 за очками · за %В — від 3 ігор"); // замало ігор у сезоні для %В
  assert.ok(!y25.some((l) => l.startsWith("💪")), "суперники — від 3 ігор");
  assert.equal(stats.card(C0(), "p1", "2025").kb.inline_keyboard[0][0].text, "• 2025");
  // невідомий рік → сезон за замовчуванням
  assert.match(stats.card(C0(), "p1", "1999").text, /^📊 Аня · #8 · Сезон 2026/);
});

test("картка: гравець без ігор — лише шапка, «ще не грав» і посилання", () => {
  assert.equal(stats.card(C0(), "p8").text, ["📊 Зоя · Сезон 2026", "У цьому періоді ще не грав.", "🔗 " + SITE + "#p8"].join("\n"));
  // грав раніше, але не в цьому сезоні: віхи за весь час лишаються
  const data = fixture(); data.games = data.games.filter((x) => x.date < "2026");
  data.games.push(g("2026-02-06", ["p2"], ["p3"], 1, 0));
  const t = stats.card(C0(data), "p1", "2026").text.split("\n");
  assert.deepEqual(t.slice(0, 3), ["📊 Аня · #8 · Сезон 2026", "У цьому періоді ще не грав.", "🎯 Віхи: до 10-ї гри — 9, до 10-ї перемоги — 9"]);
});

test("список: «Я» першим, далі лише активні за імʼям, по 2 в рядку", () => {
  const kb = stats.listKb(C0(), "p2");
  assert.deepEqual(kb.inline_keyboard.map((r) => r.map((b) => b.text)), [["Я", "Аня"], ["Вова", "Гліб"], ["Дана", "Еля"], ["Зоя"]]);
  assert.equal(kb.inline_keyboard[0][0].callback_data, "st:p2");
  // кнопка внизу й команда — те саме; незнайомцю — «не знаю»
  const pm = (text, id) => ({ text, chat: { id, type: "private" }, from: {} });
  const r = core.onMessage(C0(), pm("📊 Статистика", 102));
  assert.equal(r.msgs[0].text, stats.LIST_TEXT);
  assert.deepEqual(r.msgs[0].kb, kb);
  assert.deepEqual(core.onMessage(C0(), pm("/stats", 102)).msgs, r.msgs);
  assert.match(core.onMessage(C0(), pm("/stats", 999)).msgs[0].text, /не знаю/);
  assert.deepEqual(core.mainKb(false).keyboard.at(-1).map((b) => b.text), ["📊 Статистика", "🔕 Відписатися"]);
});

// ---------- webhook з моками: редагування повідомлення, без комітів ----------
const SECRET = "s3cr3t", env = { TG_TOKEN: "123456:TG", GH_TOKEN: "github_pat_W", TG_SECRET: SECRET, GH_REPO: "Stock3/football", GH_BRANCH: "main", SITE_ORIGIN: "https://stock3.github.io" };
function mockWorld(data = fixture()) {
  const w = { files: { "data.json": JSON.stringify(data), "index.html": HTML, "tg.json": JSON.stringify({ chats: { p1: { id: 101, u: "" }, p2: { id: 102, u: "" } } }) }, sent: [], tgCalls: [], mid: 500 };
  const gh = initGit(w);
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url); const body = opt.body ? JSON.parse(opt.body) : null;
    const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.telegram.org/bot")) {
      const method = url.split("/").pop(); w.tgCalls.push({ method, body });
      if (method === "sendMessage") { w.sent.push(body); return res(200, { ok: true, result: { message_id: ++w.mid } }); }
      return res(200, { ok: true, result: true });
    }
    const r = gh(url, opt, body, res);
    if (r) return r;
    throw new Error("Неочікуваний запит " + url);
  };
  return w;
}
const quiet = async (fn) => { const orig = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = orig; } };
async function hook(body) {
  const waits = [];
  await worker.fetch(new Request("https://bot.example/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify(body) }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
let n = 0;
const press = (data, from = 102) => quiet(() => hook({ callback_query: { id: "cb" + ++n, from: { id: from }, data, message: { message_id: 77, chat: { id: from, type: "private" } } } }));
const edits = (w) => w.tgCalls.filter((c) => c.method === "editMessageText").map((c) => c.body);

test("webhook: «📊 Статистика» → список → картка → «Весь час» → «← Інший гравець»; нічого не комітиться", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const w = mockWorld();
  await quiet(() => hook({ message: { text: "📊 Статистика", chat: { id: 102, type: "private" }, from: {} } }));
  assert.equal(w.sent.at(-1).text, stats.LIST_TEXT);
  assert.equal(w.sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, "st:p2");

  await press("st:p1");
  let e = edits(w).at(-1);
  assert.equal(e.message_id, 77);
  assert.match(e.text, /^📊 Аня · #8 · Сезон 2026\nІгор 4/);
  assert.deepEqual(e.link_preview_options, { is_disabled: true });
  assert.ok(w.tgCalls.some((c) => c.method === "answerCallbackQuery"), "callback має відповідь");

  await press("st:p1:all");
  assert.match(edits(w).at(-1).text, /^📊 Аня · #8 · Весь час/);
  await press("st:l");
  e = edits(w).at(-1);
  assert.equal(e.text, stats.LIST_TEXT);
  assert.equal(e.reply_markup.inline_keyboard[0][0].text, "Я");
  await press("st:p404");
  assert.equal(w.tgCalls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, "Гравця не знайдено");
  assert.equal((w.commits || []).length, 0, "статистика не змінює ні data.json, ні tg.json");
});

test("webhook, режим тесту: адмін дивиться статистику від імені гравця — «Я» = цей гравець, позначка «для»", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const data = fixture(); data.settings.testMode = true;
  const w = mockWorld(data);
  await quiet(() => hook({ message: { text: "/as Борис /stats", chat: { id: 101, type: "private" }, from: {} } }));
  const m = w.sent.at(-1);
  assert.equal(m.chat_id, 101);
  assert.match(m.text, /^👤 для Борис:/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, "st:p2|p2");
  await press("st:p2|p2", 101);
  const e = edits(w).at(-1);
  assert.match(e.text, /^👤 для Борис:\n📊 Борис · Сезон 2026/);
  assert.equal(e.reply_markup.inline_keyboard[1][0].callback_data, "st:l|p2");
  await press("st:p1", 102); // реальний гравець під час тесту — нічого
  assert.equal(edits(w).length, 1);
});
