// Меню адміна («⚙️ Адмін») і розсилка. Чиста логіка поверх poll.step: X — внутрішній контекст кроку, H — потрібні обробники опитування
// (передаються, щоб не було циклічного імпорту з poll.js).
//
// Розсилка — стан у tg.json (bc), окремо від причини /out (poll.wait):
//   «📣 Розсилка» → «Кому?» (all — усі підключені, game — учасники поточної гри c/y/b) → bc {step:"text"} →
//   наступне повідомлення адміна — текст → bc {step:"preview", text, ids, id} + перегляд «Отримають N: імена» [Надіслати][Скасувати] →
//   «Надіслати»: msgs усім з ids, bc прибрано. Повідомлення йдуть через deliver() (режим тесту — адміну з «👤 для Імʼя:»), тихі години не діють.
//   callback_data — «adm:…» / «bc:…» (без «|»: у режимі тесту третя частина через «|» — id гравця).
import { fill, nameOf, gameIds, chatFor, testOn, adminKb } from "./core.js";

const kbOf = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });
export const AUD = { all: "Усім підключеним", game: "Учасникам гри" };
const names = (C, ids) => ids.map((id) => nameOf(C, id)).join(", ");

// Хто отримає: all — усі підключені (у режимі тесту — усі активні гравці: бот «пише» адмін), game — учасники гри g (c/y/b).
// nobot — ті, кому писати нікуди (лише для game: у «підключених» їх за означенням немає).
export function audience(C, kind, g) {
  const all = kind === "game" ? (g ? gameIds(g) : []) : C.data.players.filter((p) => (testOn(C) ? p.active !== false : !!C.tg.chats[p.id])).map((p) => p.id);
  const ids = [], nobot = [];
  for (const pid of all) (chatFor(C, pid) ? ids : nobot).push(pid);
  return { ids, nobot };
}
export const preview = (C, bc, nobot) =>
  `📣 Розсилка · ${AUD[bc.aud]}\n\n${bc.text}\n\nОтримають ${bc.ids.length}: ${names(C, bc.ids)}` + (nobot && nobot.length ? `\nБез бота (не отримають): ${names(C, nobot)}` : "");

// Кнопки «adm:…» і «bc:…» (лише організатор)
export function cb(X, ev, H) {
  const C = X.C, [a, b, c] = String(ev.data || "").split(":");
  const ans = (t) => { X.answer.text = t; };
  const edit = (text, kb) => X.edits.push({ chat: ev.chat, msg: ev.msg, text, kb: kb || null });
  if (!X.pid || X.pid !== C.S.org) return ans(fill(C.S.say.adminOnly, {}));
  const note = () => X.notes.push("розсилка");

  if (a === "adm") {
    if (b === "menu") return edit("⚙️ Адмін", adminKb());
    if (b === "poll") return H.start(X);
    if (b === "end") return H.end(X);
    if (b === "bc") return edit("📣 Розсилка. Кому?", kbOf([[[AUD.all, "bc:all"], [AUD.game, "bc:game"]], [["Скасувати", "bc:x"]]]));
    if (b === "no") { // «Не зможе»: гравці поточної гри; натиснути імʼя = /no Імʼя
      const g = H.game(X);
      if (!X.P || !X.P.open || !g) return ans("Опитування зараз не йде");
      let head = "Хто не зможе? Обери гравця:";
      if (c) {
        if (!gameIds(g).includes(c)) return ans("Уже не в грі");
        H.markNo(X, g, c);
        head = `✅ ${nameOf(C, c)} — відмічено. Ще когось?`;
      }
      const ids = gameIds(g);
      const rows = [];
      for (let i = 0; i < ids.length; i += 2) rows.push(ids.slice(i, i + 2).map((id) => [nameOf(C, id), "adm:no:" + id]));
      rows.push([["← Назад", "adm:menu"]]);
      return edit(ids.length ? head : "У грі нікого немає", kbOf(rows));
    }
    return;
  }

  // bc:all | bc:game | bc:ok:<id> | bc:x
  if (b === "x") { delete X.tg.bc; note(); return edit("Розсилку скасовано"); }
  if (b === "all" || b === "game") {
    if (b === "game") {
      const g = H.current(X);
      if (!audience(C, "game", g).ids.length) return ans(g ? "У грі нікого немає" : "Гри немає");
    }
    X.tg.bc = { step: "text", aud: b, at: X.now };
    note();
    return edit(`📣 Розсилка · ${AUD[b]}\nНадішли текст розсилки наступним повідомленням.\n/cancel — скасувати`, kbOf([[["Скасувати", "bc:x"]]]));
  }
  if (b === "ok") {
    const bc = X.tg.bc;
    if (!bc || bc.step !== "preview") return ans("Уже неактуально");
    if (bc.id !== c) return ans("Це застарілий перегляд — дивись останній");
    const ids = bc.ids.filter((pid) => chatFor(C, pid)); // хто встиг відключитись — вже без повідомлення
    for (const pid of ids) H.toP(X, pid, bc.text, undefined, { bc: true });
    delete X.tg.bc; note();
    return edit(`📤 Розсилку надіслано: ${ids.length}\n${names(C, ids)}`);
  }
}

// Текст розсилки (наступне повідомлення адміна в кроці text/preview) → перегляд
export function text(X, ev, H) {
  const C = X.C, bc = X.tg.bc;
  const reply = (t, kb) => X.msgs.push({ chat: ev.chat, text: t, ...(kb ? { kb } : {}), ...(X.as ? { as: X.as } : {}) });
  if (!X.pid || X.pid !== C.S.org) return reply(fill(C.S.say.adminOnly, {}));
  if (!bc || (bc.step !== "text" && bc.step !== "preview")) return reply("Розсилка вже неактуальна. Почни знову: ⚙️ Адмін → 📣 Розсилка");
  const { ids, nobot } = audience(C, bc.aud, bc.aud === "game" ? H.current(X) : null);
  if (!ids.length) { delete X.tg.bc; return reply("Нікому надсилати — розсилку скасовано"); }
  const id = C.now.getTime().toString(36); // кнопка «Надіслати» належить саме цьому перегляду: новий текст робить старі кнопки неактуальними
  X.tg.bc = { step: "preview", aud: bc.aud, text: ev.text, ids, id, at: X.now };
  X.notes.push("розсилка");
  reply(preview(C, X.tg.bc, nobot), kbOf([[["📤 Надіслати", "bc:ok:" + id], ["Скасувати", "bc:x"]]]));
}

export function cancel(X, ev) {
  delete X.tg.bc;
  X.notes.push("розсилка");
  X.msgs.push({ chat: ev.chat, text: "Розсилку скасовано", ...(X.as ? { as: X.as } : {}) });
}
