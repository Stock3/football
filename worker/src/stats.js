// Статистика гравця в боті: /stats і кнопка «📊 Статистика» → інлайн-список гравців → картка (редагування того ж повідомлення).
// Розрахунок — спільний із сайтом блок ST (index.html → src/st.js), тут лише текст картки й кнопки. Чисті функції, без стану:
// крок нічого не пише в data.json / tg.json, тож pollRun не комітить, лише редагує повідомлення й відповідає на callback.
//
// callback_data (без «|»: у режимі тесту третя частина через «|» — id гравця):
//   st:l               — список гравців («← Інший гравець»)
//   st:<pid>           — картка за сезоном за замовчуванням (останній рік із зіграною грою)
//   st:<pid>:<season>  — картка за роком або «all» (весь час)
import { ST } from "./st.js";
const hesc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// кнопка: [текст, callback_data] або [текст, "url:https://…"]
const kbOf = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => (data.startsWith("url:") ? { text, url: data.slice(4) } : { text, callback_data: data }))) });
const plural = (n, f) => { const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2]; };
const pctS = (x) => Math.round(x * 100) + "%";
const sgn = (x) => { const v = Math.round(x * 10) / 10; return (v > 0 ? "+" : "") + v.toFixed(1); };
// місце (середній рід): 1-е, 2-е, 3-є, 23-є, 13-е
const ord = (n) => n + (n % 10 === 3 && n % 100 !== 13 ? "-є" : "-е");
const ddmm = (d) => { const p = d.split("-"); return p[2] + "." + p[1]; };
const FORM = { w: "🟩", l: "🟥", d: "⬜" };
const DOT = { y: "🟡", b: "🔵" };
const RES = { w: ["перемога", "перемоги", "перемог"], l: ["поразка", "поразки", "поразок"], d: ["нічия", "нічиї", "нічиїх"] };
const nameOf = (C, pid) => (C.players[pid] && C.players[pid].name) || pid;

export const LIST_TEXT = "📊 Чия статистика?";
// «Я» першим, далі активні гравці за імʼям, по 2 в рядку
export function listKb(C, me) {
  const ps = C.data.players.filter((p) => p.active !== false && p.id !== me).sort((a, b) => String(a.name).localeCompare(String(b.name), "uk"));
  const btns = [...(me && C.players[me] ? [["Я", "st:" + me]] : []), ...ps.map((p) => [p.name, "st:" + p.id])];
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return kbOf(rows);
}

// Сезони з зіграними іграми (до 3 останніх) + «Весь час»; поточний позначено «•»
function periodKb(C, pid, season) {
  const ys = ST.years(C.data.games.filter(ST.played)).slice(-3);
  const mark = (s, t) => (s === season ? "• " + t : t);
  const site = /^https?:\/\/\S+$/.test(C.site || "") ? [[["🌐 Профіль на сайті", "url:" + C.site + "#" + pid]]] : [];
  return kbOf([[...ys.map((y) => [mark(y, y), `st:${pid}:${y}`]), [mark("all", "Весь час"), `st:${pid}:all`]], ...site, [["← Інший гравець", "st:l"]]]);
}

export function seasonOf(C, season) {
  const ys = ST.years(C.data.games);
  return season === "all" || ys.includes(season) ? season : ST.defSeason(C.data.games);
}

// Картка гравця за період (parse_mode HTML: усе динамічне екранується). Розділи без даних не показуємо.
const B = (x) => "<b>" + x + "</b>";
export function card(C, pid, season0) {
  const p = C.players[pid];
  const season = seasonOf(C, season0);
  const P = ST.profile(C.data.games, pid, season, 3), s = P.s, car = P.car;
  const num = p.num != null && p.num !== "" ? " · #" + hesc(p.num) : "";
  const L = [`📊 ${B(hesc(p.name))}${num}`, season === "all" ? "Весь час" : "Сезон " + season];
  const sec = (title, lines) => { if (lines.length) L.push("", B(title), ...lines); };
  if (!s) L.push("", "У цьому періоді ще не грав");
  else {
    const R = P.rank, pts = ST.pts(s);
    L.push("", `🏆 ${ord(R.rk)} за очками` + (R.rp ? ` · ${ord(R.rp)} за %В` : ` · %В — від ${R.mg} ігор`));
    L.push(`Ігор ${B(s.g)} · ${B(s.w + "–" + s.d + "–" + s.l)} · ${B(pts)} ${plural(pts, ["очко", "очки", "очок"])}`);
    L.push(`Перемог ${B(pctS(s.pct))} · +/− ${B(sgn(s.gd))}`);
    L.push(`Відвідуваність ${B(pctS(s.att))}`);
    const seq = s.seq.slice(-5);
    if (seq.length) {
      L.push("", B("Форма") + "  " + seq.map((r) => FORM[r]).join(""));
      const tail = [];
      if (s.cur.n > 1) tail.push(`Серія: ${s.cur.n} ${plural(s.cur.n, RES[s.cur.r])}`);
      if (s.bestStreak > 0) tail.push(`рекорд ${s.bestStreak} ${plural(s.bestStreak, RES.w)}`);
      if (tail.length) L.push(tail.join(" · "));
    }
    if (P.last.length) sec("Останні ігри", P.last.map((x) => `${ddmm(x.g.date)}  ${DOT[x.side]} ${x.my}:${x.op}`));
    const col = (t) => { const x = s.t[t]; return DOT[t] + " " + (x.g ? B(x.w + "–" + x.d + "–" + x.l) : "—"); };
    L.push("", B("Кольори") + "  " + col("y") + "  ·  " + col("b"));
    const foe = (list, k) => list.slice(0, 2).map((q) => `${hesc(nameOf(C, q.id))} ${q[k]}/${q.g}`).join(" · ");
    sec("Суперники", [...(P.foes.beat.length ? ["💪 " + foe(P.foes.beat, "w")] : []), ...(P.foes.lose.length ? ["😬 " + foe(P.foes.lose, "l")] : [])]);
  }
  if (car) sec("Віхи", [[car.g, "гра"], [car.w, "перемога"]].map(([v, w]) => `🎯 ${ST.nextMs(v)}-та ${w} — ще ${ST.nextMs(v) - v}`));
  return { text: L.join("\n"), kb: periodKb(C, pid, season), html: true };
}

// Кнопки «st:…» (з poll.step; edit — редагування повідомлення з урахуванням режиму тесту)
export function cb(X, ev, edit) {
  const C = X.C, [, who, season] = String(ev.data || "").split("|")[0].split(":");
  const m = { chat: ev.chat, msg: ev.msg };
  if (who === "l" || !C.players[who]) {
    if (who !== "l") X.answer.text = "Гравця не знайдено";
    return edit(X, m, LIST_TEXT, listKb(C, X.pid));
  }
  const r = card(C, who, season);
  edit(X, m, r.text, r.kb, { nopv: true, html: true });
}
