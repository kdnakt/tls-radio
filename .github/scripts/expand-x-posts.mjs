// issueコメントに貼られた X (Twitter) のポストURLについて、
// 本文とリンク先URLを oEmbed で取得し、返信コメントとして書き込む。
// 依存パッケージなし（Node.js 20+ の fetch を使用）。

const MARKER_PREFIX = "<!-- x-post-expander source-comment:";
const MARKER_RE = /<!-- x-post-expander source-comment:(\d+) -->/g;
const STATUS_URL_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)[^\s<>()\[\]]*/g;
const TCO_RE = /^https?:\/\/t\.co\//;

// ---------- 純粋関数（テスト対象） ----------

/** テキストからポストURLを抜き出す（ポストIDで重複排除） */
export function extractStatusUrls(text) {
  const seen = new Map();
  for (const m of (text ?? "").matchAll(STATUS_URL_RE)) {
    const [original, user, id] = m;
    if (!seen.has(id)) {
      seen.set(id, { id, user, original, canonical: `https://x.com/${user}/status/${id}` });
    }
  }
  return [...seen.values()];
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? all;
  });
}

/**
 * oEmbed の html（blockquote）から本文・リンク・日付を取り出す。
 * 本文中の <a> は href に置き換える（t.co は後で展開する）。
 */
export function parseOEmbedHtml(html) {
  const pMatch = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  const body = pMatch ? pMatch[1] : "";
  const links = [];
  const withHrefs = body.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const url = decodeEntities(href);
    const text = decodeEntities(label.replace(/<[^>]+>/g, ""));
    // @ユーザー名 や #ハッシュタグ はリンクではなく文字として残す
    if (/^[@#＃]/.test(text)) return text;
    links.push({ url, text });
    return url;
  });
  const text = decodeEntities(
    withHrefs.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  ).trim();

  // 末尾の「&mdash; 名前 (@id) <a ...>日付</a>」から日付を取る
  const after = pMatch ? html.slice(html.indexOf(pMatch[0]) + pMatch[0].length) : html;
  const dateMatch = after.match(/<a\b[^>]*>([^<]+)<\/a>\s*<\/blockquote>/i);
  const date = dateMatch ? decodeEntities(dateMatch[1]).trim() : "";
  return { text, links, date };
}

/** GitHub の @メンション と issue 参照で通知・相互参照が飛ばないようにする */
export function neutralize(s) {
  return s
    .replace(/@(?=[A-Za-z0-9_-])/g, "@​")
    .replace(/(^|[^&\w])#(?=\d)/g, "$1#​")
    .replace(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#/g, "$1​#");
}

function quote(s) {
  return s
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** 返信コメントの本文を組み立てる */
export function buildReply(sourceComment, results) {
  const parts = [
    `${MARKER_PREFIX}${sourceComment.id} -->`,
    `**Xポストの内容（自動取得）** — [元コメント](${sourceComment.html_url})`,
  ];
  for (const r of results) {
    parts.push("");
    if (!r.ok) {
      parts.push(`#### ${r.post.canonical}`, `> 取得できませんでした（${r.error}）`);
      continue;
    }
    const header = `${r.author}${r.date ? ` · ${r.date}` : ""}`;
    parts.push(`#### ${neutralize(header)}`, r.post.canonical, "", quote(neutralize(r.text)));
    const external = r.links.filter((l) => !l.isMedia);
    const media = r.links.filter((l) => l.isMedia);
    if (external.length) {
      parts.push("", "リンク先:");
      for (const l of external) parts.push(`- ${l.expanded}`);
    }
    if (media.length) parts.push("", `（画像・動画 ${media.length}件）`);
  }
  return parts.join("\n");
}

export function existingSourceIds(comments) {
  const ids = new Set();
  for (const c of comments) {
    for (const m of (c.body ?? "").matchAll(MARKER_RE)) ids.add(m[1]);
  }
  return ids;
}

/** 処理対象のコメントか（オーナー本人のコメントで、Xのリンクを含み、未処理） */
export function shouldProcess(comment, doneIds) {
  if (comment.user?.type === "Bot") return false;
  if (comment.author_association !== "OWNER") return false;
  if ((comment.body ?? "").includes(MARKER_PREFIX)) return false;
  if (doneIds.has(String(comment.id))) return false;
  return extractStatusUrls(comment.body).length > 0;
}

// ---------- ネットワーク ----------

const UA = "Mozilla/5.0 (compatible; tls-radio-x-post-expander; +https://github.com/kdnakt/tls-radio)";

export async function expandTco(url, fetchImpl = fetch) {
  if (!TCO_RE.test(url)) return url;
  try {
    const res = await fetchImpl(url, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = res.headers.get("location");
    if (loc) return loc;
    const body = await res.text();
    const meta = body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'>]+)["']/i);
    if (meta) return decodeEntities(meta[1]);
    const title = body.match(/<title>\s*(https?:\/\/[^<\s]+)\s*<\/title>/i);
    if (title) return decodeEntities(title[1]);
  } catch {
    // 展開に失敗したら t.co のまま残す
  }
  return url;
}

export async function fetchPost(post, fetchImpl = fetch) {
  const target = `https://twitter.com/${post.user}/status/${post.id}`;
  const api = `https://publish.twitter.com/oembed?omit_script=true&dnt=true&lang=ja&url=${encodeURIComponent(target)}`;
  let res;
  try {
    res = await fetchImpl(api, { headers: { "User-Agent": UA } });
  } catch (e) {
    return { ok: false, post, error: `通信エラー: ${e.message}` };
  }
  if (!res.ok) {
    const hint = res.status === 404 ? ": 削除・非公開・鍵アカウントの可能性" : "";
    return { ok: false, post, error: `HTTP ${res.status}${hint}` };
  }
  const data = await res.json();
  const parsed = parseOEmbedHtml(data.html ?? "");
  const handle = (data.author_url ?? "").split("/").filter(Boolean).pop() ?? post.user;
  const links = [];
  let text = parsed.text;
  for (const l of parsed.links) {
    const expanded = await expandTco(l.url, fetchImpl);
    const isMedia =
      /^pic\.(twitter|x)\.com\//.test(l.text) || /\/(photo|video)\/\d+$/.test(expanded);
    links.push({ ...l, expanded, isMedia });
    text = text.split(l.url).join(isMedia ? "" : expanded);
  }
  return {
    ok: true,
    post,
    author: `${data.author_name ?? post.user} (@${handle})`,
    date: parsed.date,
    text: text.replace(/[ \t]+\n/g, "\n").trim(),
    links,
  };
}

// ---------- GitHub API ----------

function gh(token, fetchImpl = fetch) {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tls-radio-x-post-expander",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
}

async function listAll(api, path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await api("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

export async function processIssue({ api, repo, issueNumber, onlyCommentId, fetchImpl = fetch, log = console.log }) {
  const comments = await listAll(api, `/repos/${repo}/issues/${issueNumber}/comments`);
  const done = existingSourceIds(comments);
  const targets = comments.filter(
    (c) => (onlyCommentId ? String(c.id) === String(onlyCommentId) : true) && shouldProcess(c, done)
  );
  log(`#${issueNumber}: コメント${comments.length}件中、処理対象${targets.length}件`);
  for (const c of targets) {
    const results = [];
    for (const post of extractStatusUrls(c.body)) {
      results.push(await fetchPost(post, fetchImpl));
    }
    await api("POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body: buildReply(c, results) });
    const ng = results.filter((r) => !r.ok).length;
    log(`  comment ${c.id}: ポスト${results.length}件（取得失敗${ng}件）を返信しました`);
  }
  return targets.length;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN と GITHUB_REPOSITORY が必要です");
  const api = gh(token);
  const issueNumber = (process.env.ISSUE_NUMBER ?? "").trim();
  const commentId = (process.env.COMMENT_ID ?? "").trim();

  if (issueNumber) {
    await processIssue({ api, repo, issueNumber, onlyCommentId: commentId || undefined });
    return;
  }
  // 手動実行で issue 番号の指定がなければ、オープン中の issue をすべて処理する
  const issues = (await listAll(api, `/repos/${repo}/issues?state=open`)).filter((i) => !i.pull_request);
  for (const i of issues) await processIssue({ api, repo, issueNumber: i.number });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
