// Мок GitHub для тестів: Contents API (читання) + Git Data API (запис одним комітом).
// Стан репозиторію — w.files (вміст на голові гілки). Пряма зміна w.files у тесті = чужий коміт (сайт, інший запуск бота).
// sha файлу — git-подібний хеш вмісту (як у справжньому API: sha з Contents = sha блоба в дереві).
// w.commits — успішні коміти бота [{message, files:[шляхи]}]; w.attempts — спроби оновити гілку (PATCH ref).
// w.conflicts — скільки наступних оновлень гілки відхилити як non-fast-forward (onConflict(w) — що «встиг» записати інший).
import { createHash } from "node:crypto";

const REPO = "https://api.github.com/repos/Stock3/football";
export const blobSha = (s) => createHash("sha1").update("blob " + Buffer.byteLength(s, "utf8") + "\0" + s).digest("hex");

export function initGit(w, { onConflict } = {}) {
  w.commits = []; w.attempts = []; w.conflicts = w.conflicts || 0;
  const G = { n: 0, commits: {}, trees: {}, head: null };
  const snap = () => JSON.stringify(w.files);
  const newTree = (files) => { const sha = "t" + ++G.n; G.trees[sha] = { ...files }; return sha; };
  const newCommit = (tree, parent, message) => { const sha = "c" + ++G.n; G.commits[sha] = { tree, parent, message, key: JSON.stringify(G.trees[tree]) }; return sha; };
  G.head = newCommit(newTree(w.files), null, "init");
  // голова гілки; якщо тест змінив w.files напряму — це новий (чужий) коміт
  const head = () => {
    if (G.commits[G.head].key !== snap()) G.head = newCommit(newTree(w.files), G.head, "чужий коміт");
    return G.head;
  };
  w.git = G; w.head = head;
  w.foreignCommit = () => { head(); G.head = newCommit(newTree(w.files), G.head, "чужий коміт"); };
  return function gh(url, opt, body, res) {
    const m = opt.method || "GET";
    let x;
    if ((x = url.match(/^https:\/\/api\.github\.com\/repos\/Stock3\/football\/contents\/([^?]+)\?ref=main$/)) && m === "GET") {
      head();
      const f = x[1];
      return f in w.files ? res(200, { content: Buffer.from(w.files[f], "utf8").toString("base64").replace(/(.{60})/g, "$1\n"), sha: blobSha(w.files[f]) }) : res(404, {});
    }
    if (url === REPO + "/git/ref/heads/main" && m === "GET") return res(200, { ref: "refs/heads/main", object: { type: "commit", sha: head() } });
    if ((x = url.match(/\/git\/commits\/(\w+)$/)) && m === "GET") {
      const c = G.commits[x[1]];
      return c ? res(200, { sha: x[1], tree: { sha: c.tree }, parents: c.parent ? [{ sha: c.parent }] : [] }) : res(404, {});
    }
    if ((x = url.match(/\/git\/trees\/(\w+)$/)) && m === "GET") {
      const t = G.trees[x[1]];
      return t ? res(200, { sha: x[1], tree: Object.entries(t).map(([path, s]) => ({ path, mode: "100644", type: "blob", sha: blobSha(s) })), truncated: false }) : res(404, {});
    }
    if (url === REPO + "/git/trees" && m === "POST") {
      const base = G.trees[body.base_tree];
      if (!base) return res(422, { message: "base_tree" });
      const files = { ...base };
      for (const e of body.tree) {
        if (e.sha === null) delete files[e.path];
        else { if (e.mode !== "100644" || e.type !== "blob" || typeof e.content !== "string") return res(422, { message: "bad entry" }); files[e.path] = e.content; }
      }
      // однаковий вміст — те саме дерево (як у git)
      const same = JSON.stringify(files) === JSON.stringify(base);
      return res(201, { sha: same ? body.base_tree : newTree(files) });
    }
    if (url === REPO + "/git/commits" && m === "POST") {
      if (!G.trees[body.tree] || body.parents.length !== 1 || !G.commits[body.parents[0]]) return res(422, { message: "bad commit" });
      return res(201, { sha: newCommit(body.tree, body.parents[0], body.message) });
    }
    if (url === REPO + "/git/refs/heads/main" && m === "PATCH") {
      const c = G.commits[body.sha];
      w.attempts.push({ message: c && c.message, force: body.force });
      if (w.conflicts > 0) {
        w.conflicts--;
        if (onConflict) onConflict(w);
        w.foreignCommit();
      }
      if (!c || body.force !== false || c.parent !== head()) return res(422, { message: "Update is not a fast forward" });
      const before = G.trees[G.commits[G.head].tree], after = G.trees[c.tree];
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
      w.files = { ...after }; G.head = body.sha;
      w.commits.push({ message: c.message, files: changed });
      return res(200, { ref: "refs/heads/main", object: { sha: body.sha } });
    }
    return null;
  };
}
