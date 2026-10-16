import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractStatusUrls, decodeEntities, parseOEmbedHtml, neutralize, buildReply,
  existingSourceIds, shouldProcess, expandTco, fetchPost, processIssue,
} from "./expand-x-posts.mjs";

const ZW = "​";

test("extractStatusUrls: 通常/モバイル/twitter/i-web 形式、ID重複排除", () => {
  const posts = extractStatusUrls(`
    https://x.com/alice/status/111?s=20
    https://twitter.com/alice/statuses/111
    https://mobile.twitter.com/bob/status/222
    https://x.com/i/web/status/333
    https://x.com/i/status/444
  `);
  assert.deepEqual(posts, [
    { id: "111", user: "alice", canonical: "https://x.com/alice/status/111" },
    { id: "222", user: "bob", canonical: "https://x.com/bob/status/222" },
    { id: "333", user: "i", canonical: "https://x.com/i/status/333" },
    { id: "444", user: "i", canonical: "https://x.com/i/status/444" },
  ]);
  assert.deepEqual(extractStatusUrls(null), []);
});

test("decodeEntities: 名前付き・数値・範囲外", () => {
  assert.equal(decodeEntities("a &amp; b &#x1F600; &#65; &mdash;"), "a & b 😀 A —");
  assert.equal(decodeEntities("&#9999999; &#xD800; &bogus;"), "&#9999999; &#xD800; &bogus;");
});

test("neutralize: メンション/issue参照は無効化、URL内は無変更", () => {
  assert.equal(neutralize("hi @alice see #12 and kdnakt/tls-radio#3"),
    `hi @${ZW}alice see #${ZW}12 and kdnakt/tls-radio${ZW}#3`);
  const u = "https://medium.com/@someone/post https://github.com/o/r/blob/main.js#L10";
  assert.equal(neutralize(`read ${u} by @me`), `read ${u} by @${ZW}me`);
  assert.equal(neutralize("no urls"), "no urls");
  assert.equal(neutralize(""), "");
});

const OEMBED_HTML = `<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">TLS 1.3 の話 <a href="https://twitter.com/hashtag/tls?src=hash">#tls</a> <a href="https://t.co/abc">https://t.co/abc</a><br>画像 <a href="https://t.co/pic">pic.twitter.com/pic</a> &amp; <a href="https://twitter.com/bob">@bob</a></p>&mdash; Alice (@alice) <a href="https://twitter.com/alice/status/111">October 1, 2026</a></blockquote>`;

test("parseOEmbedHtml", () => {
  const r = parseOEmbedHtml(OEMBED_HTML);
  assert.equal(r.text, "TLS 1.3 の話 #tls https://t.co/abc\n画像 https://t.co/pic & @bob");
  assert.deepEqual(r.links, [
    { url: "https://t.co/abc", text: "https://t.co/abc" },
    { url: "https://t.co/pic", text: "pic.twitter.com/pic" },
  ]);
  assert.equal(r.date, "October 1, 2026");
});

function mockFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    assert.ok(opts.signal instanceof AbortSignal, "fetch にタイムアウト signal が渡される");
    const r = routes[url] ?? routes["*"];
    if (!r) throw new Error(`unexpected ${url}`);
    if (r instanceof Error) throw r;
    return {
      ok: r.status < 400, status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => { if (r.json === undefined) throw new SyntaxError("Unexpected token <"); return r.json; },
      text: async () => r.text ?? "",
    };
  };
  f.calls = calls;
  return f;
}

test("expandTco: location / meta refresh / title / 失敗", async () => {
  const f = mockFetch({
    "https://t.co/a": { status: 301, headers: { location: "https://example.com/a" } },
    "https://t.co/b": { status: 200, text: `<meta http-equiv="refresh" content="0;URL=https://example.com/b?x=1&amp;y=2">` },
    "https://t.co/c": { status: 200, text: `<title>https://example.com/c</title>` },
    "https://t.co/d": new Error("boom"),
  });
  assert.equal(await expandTco("https://t.co/a", f), "https://example.com/a");
  assert.equal(await expandTco("https://t.co/b", f), "https://example.com/b?x=1&y=2");
  assert.equal(await expandTco("https://t.co/c", f), "https://example.com/c");
  assert.equal(await expandTco("https://t.co/d", f), "https://t.co/d");
  assert.equal(await expandTco("https://example.com", f), "https://example.com");
});

const OEMBED_API = (user, id) =>
  `https://publish.twitter.com/oembed?omit_script=true&dnt=true&lang=ja&url=${encodeURIComponent(`https://twitter.com/${user}/status/${id}`)}`;
const post = { id: "111", user: "alice", canonical: "https://x.com/alice/status/111" };

test("fetchPost: 成功", async () => {
  const f = mockFetch({
    [OEMBED_API("alice", "111")]: { status: 200, json: { html: OEMBED_HTML, author_name: "Alice", author_url: "https://twitter.com/alice" } },
    "https://t.co/abc": { status: 301, headers: { location: "https://medium.com/@someone/post" } },
    "https://t.co/pic": { status: 301, headers: { location: "https://twitter.com/alice/status/111/photo/1" } },
  });
  const r = await fetchPost(post, f);
  assert.equal(r.ok, true);
  assert.equal(r.author, "Alice (@alice)");
  assert.equal(r.text, "TLS 1.3 の話 #tls https://medium.com/@someone/post\n画像  & @bob");
  assert.deepEqual(r.links.map((l) => [l.expanded, l.isMedia]), [
    ["https://medium.com/@someone/post", false],
    ["https://twitter.com/alice/status/111/photo/1", true],
  ]);
});

test("fetchPost: 失敗の分類", async () => {
  const cases = [
    [{ status: 404 }, false, /HTTP 404: 削除/],
    [{ status: 403 }, false, /HTTP 403/],
    [{ status: 429 }, true, /HTTP 429/],
    [{ status: 503 }, true, /HTTP 503/],
    [new Error("ECONNRESET"), true, /通信エラー: ECONNRESET/],
    [{ status: 200 }, true, /応答の解析に失敗/],
  ];
  for (const [route, retryable, re] of cases) {
    const r = await fetchPost(post, mockFetch({ "*": route }));
    assert.equal(r.ok, false);
    assert.equal(r.retryable, retryable, `${re}`);
    assert.match(r.error, re);
  }
});

test("buildReply", () => {
  const src = { id: 99, html_url: "https://github.com/kdnakt/tls-radio/issues/1#issuecomment-99" };
  const body = buildReply(src, [
    { ok: true, post, author: "Alice (@alice)", date: "October 1, 2026",
      text: "hello @bob see #12\n\nhttps://medium.com/@someone/post",
      links: [{ expanded: "https://medium.com/@someone/post", isMedia: false }, { expanded: "x", isMedia: true }] },
    { ok: false, post: { canonical: "https://x.com/i/status/333" }, error: "HTTP 404: 削除・非公開・鍵アカウントの可能性" },
  ]);
  assert.equal(body, [
    "<!-- x-post-expander source-comment:99 -->",
    "**Xポストの内容（自動取得）** — [元コメント](https://github.com/kdnakt/tls-radio/issues/1#issuecomment-99)",
    "",
    `#### Alice (@${ZW}alice) · October 1, 2026`,
    "https://x.com/alice/status/111",
    "",
    `> hello @${ZW}bob see #${ZW}12`,
    ">",
    "> https://medium.com/@someone/post",
    "",
    "リンク先:",
    "- https://medium.com/@someone/post",
    "",
    "（画像・動画 1件）",
    "",
    "#### https://x.com/i/status/333",
    "> 取得できませんでした（HTTP 404: 削除・非公開・鍵アカウントの可能性）",
  ].join("\n"));
});

test("existingSourceIds / shouldProcess", () => {
  const done = existingSourceIds([{ body: "x <!-- x-post-expander source-comment:1 --> <!-- x-post-expander source-comment:2 -->" }, { body: null }]);
  assert.deepEqual([...done], ["1", "2"]);
  const owner = (over) => ({ id: 5, user: { type: "User" }, author_association: "OWNER", body: "https://x.com/a/status/1", ...over });
  assert.equal(shouldProcess(owner({}), done), true);
  assert.equal(shouldProcess(owner({ id: 1 }), done), false);
  assert.equal(shouldProcess(owner({ user: { type: "Bot" } }), done), false);
  assert.equal(shouldProcess(owner({ author_association: "CONTRIBUTOR" }), done), false);
  assert.equal(shouldProcess(owner({ body: "<!-- x-post-expander source-comment:5 --> https://x.com/a/status/1" }), done), false);
  assert.equal(shouldProcess(owner({ body: "no link" }), done), false);
});

function mockApi(initialComments) {
  const comments = [...initialComments];
  const posted = [];
  const api = async (method, path, body) => {
    if (method === "GET") {
      const page = Number(new URL("http://x" + path).searchParams.get("page"));
      return page === 1 ? comments : [];
    }
    posted.push(body.body);
    comments.push({ id: 1000 + posted.length, user: { type: "Bot" }, author_association: "NONE", body: body.body });
    return {};
  };
  api.posted = posted;
  api.comments = comments;
  return api;
}
const ownerComment = (id, body) => ({ id, html_url: `https://example/${id}`, user: { type: "User" }, author_association: "OWNER", body });

test("processIssue: 未処理コメントをすべて処理し、処理済み・Bot はスキップ", async () => {
  const api = mockApi([
    ownerComment(1, "https://x.com/alice/status/111"),
    ownerComment(2, "https://x.com/alice/status/222"),
    ownerComment(3, "https://x.com/alice/status/333"),
    { id: 4, user: { type: "Bot" }, author_association: "NONE", body: "<!-- x-post-expander source-comment:2 --> done" },
  ]);
  const f = mockFetch({
    [OEMBED_API("alice", "111")]: { status: 200, json: { html: "<p>one</p>", author_name: "A", author_url: "https://twitter.com/alice" } },
    [OEMBED_API("alice", "333")]: { status: 404 },
  });
  const logs = [];
  const r = await processIssue({ api, repo: "o/r", issueNumber: 7, fetchImpl: f, log: (m) => logs.push(m) });
  assert.deepEqual(r, { replied: 2, deferred: 0 });
  assert.equal(api.posted.length, 2);
  assert.match(api.posted[0], /source-comment:1 -->/);
  assert.match(api.posted[0], /> one/);
  assert.match(api.posted[1], /source-comment:3 -->/);
  assert.match(api.posted[1], /HTTP 404/);
});

test("processIssue: 一時的なエラーは返信せず見送る（マーカーを残さない）", async () => {
  const api = mockApi([ownerComment(1, "https://x.com/alice/status/111 https://x.com/alice/status/222")]);
  const f = mockFetch({
    [OEMBED_API("alice", "111")]: { status: 200, json: { html: "<p>one</p>" } },
    [OEMBED_API("alice", "222")]: { status: 429 },
  });
  const logs = [];
  const r = await processIssue({ api, repo: "o/r", issueNumber: 7, fetchImpl: f, log: (m) => logs.push(m) });
  assert.deepEqual(r, { replied: 0, deferred: 1 });
  assert.equal(api.posted.length, 0);
  assert.match(logs.join("\n"), /見送り.*HTTP 429/);
});

test("processIssue: 投稿直前に別実行が返信済みならスキップ", async () => {
  const api = mockApi([ownerComment(1, "https://x.com/alice/status/111")]);
  const f = mockFetch({ "*": { status: 200, json: { html: "<p>one</p>" } } });
  // 1回目の GET の後（fetchPost 中）に別実行の返信が入る
  const origFetch = f;
  const racing = async (url, opts) => {
    api.comments.push({ id: 500, user: { type: "Bot" }, body: "<!-- x-post-expander source-comment:1 -->" });
    return origFetch(url, opts);
  };
  const r = await processIssue({ api, repo: "o/r", issueNumber: 7, fetchImpl: racing, log: () => {} });
  assert.deepEqual(r, { replied: 0, deferred: 0 });
  assert.equal(api.posted.length, 0);
});
