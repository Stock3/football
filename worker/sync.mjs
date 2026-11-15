// Копіює самодостатні ES5-блоки з ../index.html у src/ (спільний код сайту й бота):
//   погода /*WX*/…/*/WX*/ → src/wx.js, баланс /*BAL*/…/*/BAL*/ → src/bal.js, статистика /*ST*/…/*/ST*/ → src/st.js.
// Новий спільний блок — дописати в BLOCKS; тест на розходження (test/core.test.mjs) бере той самий список.
// Cloudflare Workers не дозволяють new Function/eval, тож Worker не може виконати блок прямо з index.html, як сайт.
// Запуск після зміни будь-якого з блоків в index.html:  node worker/sync.mjs
// Тест worker/test/core.test.mjs падає, якщо копія розійшлася з index.html.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "..", "index.html"), "utf8").replace(/\r\n/g, "\n"); // копія не залежить від core.autocrlf
export const BLOCKS = [["WX", "wx.js"], ["BAL", "bal.js"], ["ST", "st.js"]];
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) for (const [tag, file] of BLOCKS) {
  const m = html.match(new RegExp("/\\*" + tag + "\\*/[\\s\\S]*?/\\*/" + tag + "\\*/"));
  if (!m) throw new Error(`У index.html немає блоку /*${tag}*/`);
  fs.writeFileSync(path.join(dir, "src", file),
    `// АВТОМАТИЧНА КОПІЯ блоку ${tag} з index.html — не редагувати тут. Оновити: node worker/sync.mjs\n` +
    `export const ${tag} = (` + m[0] + ")();\n");
  console.log(`worker/src/${file} оновлено`);
}
