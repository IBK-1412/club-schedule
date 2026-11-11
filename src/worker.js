// 部活の予定調整（曜日 × 時限）投票ツール — Cloudflare Workers + D1
// ルート:
//   GET  /                         作成画面
//   GET  /p/:id                    投票・集計画面（?admin=KEY で管理機能）
//   POST /api/polls                投票を作成
//   GET  /api/polls/:id            投票の内容と全回答
//   POST /api/polls/:id/votes      回答の登録・上書き（名前単位）
//   POST /api/polls/:id/admin      管理操作（締切・決定・回答削除・削除）

import CLIENT from './client.js';

const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日'];
const PERIODS = {
  1: '8:45〜10:25',
  2: '10:45〜12:20',
  3: '13:10〜14:50',
  4: '15:05〜16:45',
  5: '17:00〜18:40',
  6: '18:55〜20:35',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/' || path === '/new') return html(page({ title: '予定調整をつくる' }));
      let m = path.match(/^\/p\/([A-Za-z0-9]{6,16})$/);
      if (m && request.method === 'GET') {
        const poll = await env.DB.prepare('SELECT title FROM polls WHERE id = ?').bind(m[1]).first();
        if (!poll) return html(page({ title: '見つかりません' }), 404);
        return html(page({ title: poll.title, desc: '空いている授業時間に ○△× をつけてください' }));
      }
      if (path === '/api/polls' && request.method === 'POST') return createPoll(request, env);
      m = path.match(/^\/api\/polls\/([A-Za-z0-9]{6,16})(\/votes|\/admin)?$/);
      if (m) {
        const id = m[1];
        if (!m[2] && request.method === 'GET') return getPoll(id, env, url.searchParams.get('admin'));
        if (m[2] === '/votes' && request.method === 'POST') return putVote(id, request, env);
        if (m[2] === '/admin' && request.method === 'POST') return admin(id, request, env);
      }
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'サーバーエラー: ' + (e && e.message) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function rid(n) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += a[x % a.length];
  return s;
}
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const cleanMulti = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function createPoll(request, env) {
  const b = await body(request);
  const title = clean(b.title, 60);
  if (!title) return json({ error: 'タイトルを入れてください' }, 400);
  const days = [...new Set((b.days || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
  const periods = [...new Set((b.periods || []).map(Number))].filter((p) => PERIODS[p]).sort();
  if (!days.length || !periods.length) return json({ error: '曜日と時限を1つ以上選んでください' }, 400);
  const id = rid(8);
  const adminKey = rid(16);
  await env.DB.prepare(
    'INSERT INTO polls (id, title, note, days, periods, admin_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, title, cleanMulti(b.note, 500), JSON.stringify(days), JSON.stringify(periods), adminKey, Date.now()).run();
  return json({ id, adminKey });
}

async function loadPoll(id, env) {
  const p = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!p) return null;
  p.days = JSON.parse(p.days);
  p.periods = JSON.parse(p.periods);
  return p;
}

async function getPoll(id, env, adminKey) {
  const p = await loadPoll(id, env);
  if (!p) return json({ error: 'この投票は見つかりません（削除された可能性があります）' }, 404);
  const { results } = await env.DB.prepare(
    'SELECT name, answers, comment, updated_at FROM votes WHERE poll_id = ? ORDER BY updated_at'
  ).bind(id).all();
  return json({
    id: p.id,
    title: p.title,
    note: p.note,
    days: p.days,
    periods: p.periods,
    closed: !!p.closed,
    decided: p.decided,
    isAdmin: !!adminKey && adminKey === p.admin_key,
    votes: results.map((v) => ({ name: v.name, answers: JSON.parse(v.answers), comment: v.comment, updatedAt: v.updated_at })),
  });
}

// 既存DB向け: votes.token 列がなければ追加（初回だけ）
let migrated = null;
function migrate(env) {
  if (!migrated) {
    migrated = env.DB.prepare("ALTER TABLE votes ADD COLUMN token TEXT NOT NULL DEFAULT ''").run().catch(() => {});
  }
  return migrated;
}

async function putVote(id, request, env) {
  await migrate(env);
  const p = await loadPoll(id, env);
  if (!p) return json({ error: 'この投票は見つかりません' }, 404);
  if (p.closed) return json({ error: 'この投票は締め切られています' }, 403);
  const b = await body(request);
  const name = clean(b.name, 20);
  if (!name) return json({ error: '名前を入れてください' }, 400);
  const oldName = clean(b.oldName, 20);
  const token = clean(b.token, 40);
  const isAdmin = !!b.adminKey && b.adminKey === p.admin_key;
  // 本人（その回答を作った端末のトークン）か管理者だけが編集できる
  // token が空の行は更新前の回答。前の版で「自分の回答」として記録した端末（claim）だけ引き継げる
  const claim = clean(b.claim, 20);
  const canEdit = (row, n) => isAdmin || (!!token && row.token === token) || (row.token === '' && claim === n);
  const getRow = (n) => env.DB.prepare('SELECT token FROM votes WHERE poll_id = ? AND name = ?').bind(id, n).first();

  let keepToken = '';
  if (oldName) {
    const oldRow = await getRow(oldName);
    if (oldRow) {
      if (!canEdit(oldRow, oldName)) return json({ error: '「' + oldName + '」の回答は、回答した端末からしか編集できません' }, 403);
      keepToken = oldRow.token;
    }
  }
  const sameRow = await getRow(name);
  if (sameRow && name !== oldName) {
    if (!canEdit(sameRow, name)) return json({ error: '「' + name + '」はすでに回答があります。別の名前にしてください（自分の回答なら、回答した端末から編集してください）' }, 409);
    keepToken = keepToken || sameRow.token;
  }
  if (!sameRow) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE poll_id = ?').bind(id).first();
    if (count.n >= 200) return json({ error: '回答数の上限（200人）に達しています' }, 400);
  }
  const answers = {};
  for (const d of p.days) for (const per of p.periods) {
    const k = d + '-' + per;
    const v = Number(b.answers && b.answers[k]);
    answers[k] = v === 2 || v === 1 ? v : 0;
  }
  const newToken = keepToken || rid(20);
  const stmts = [];
  if (oldName && oldName !== name) {
    stmts.push(env.DB.prepare('DELETE FROM votes WHERE poll_id = ? AND name = ?').bind(id, oldName));
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO votes (poll_id, name, answers, comment, updated_at, token) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(poll_id, name) DO UPDATE SET answers = excluded.answers, comment = excluded.comment, updated_at = excluded.updated_at, token = excluded.token`
    ).bind(id, name, JSON.stringify(answers), clean(b.comment, 200), Date.now(), newToken)
  );
  await env.DB.batch(stmts);
  // 管理者が他人の回答を直したときは、その人のトークンを管理者の端末に渡さない
  return json({ ok: true, token: isAdmin && keepToken && keepToken !== token ? '' : newToken });
}

async function admin(id, request, env) {
  const p = await loadPoll(id, env);
  if (!p) return json({ error: 'この投票は見つかりません' }, 404);
  const b = await body(request);
  if (!b.adminKey || b.adminKey !== p.admin_key) return json({ error: '管理用URLから開いてください' }, 403);
  switch (b.action) {
    case 'close':
      await env.DB.prepare('UPDATE polls SET closed = ? WHERE id = ?').bind(b.value ? 1 : 0, id).run();
      break;
    case 'decide': {
      const k = clean(b.value, 10);
      if (k && !/^\d-\d$/.test(k)) return json({ error: 'bad slot' }, 400);
      await env.DB.prepare('UPDATE polls SET decided = ? WHERE id = ?').bind(k, id).run();
      break;
    }
    case 'deleteVote':
      await env.DB.prepare('DELETE FROM votes WHERE poll_id = ? AND name = ?').bind(id, clean(b.name, 20)).run();
      break;
    case 'edit': {
      const title = clean(b.title, 60);
      if (!title) return json({ error: 'タイトルを入れてください' }, 400);
      await env.DB.prepare('UPDATE polls SET title = ?, note = ? WHERE id = ?').bind(title, cleanMulti(b.note, 500), id).run();
      break;
    }
    case 'deletePoll':
      await env.DB.batch([
        env.DB.prepare('DELETE FROM votes WHERE poll_id = ?').bind(id),
        env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(id),
      ]);
      break;
    default:
      return json({ error: 'unknown action' }, 400);
  }
  return json({ ok: true });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page({ title, desc = '部活の集まりの曜日・時限を ○△× で投票して決める' }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}｜予定調整</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0f766e">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%97%93%3C/text%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<header class="bar"><a href="/" class="brand">🗓 予定調整</a></header>
<main id="app"><p class="muted center">読み込み中…</p></main>
<div id="toast" role="status"></div>
<script>
const DAY_NAMES = ${JSON.stringify(DAY_NAMES)};
const PERIODS = ${JSON.stringify(PERIODS)};
${CLIENT}
</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1f2937;--muted:#6b7280;--line:#e5e7eb;--accent:#0f766e;--accent2:#14b8a6;
--ok:#16a34a;--okbg:#dcfce7;--mid:#ca8a04;--midbg:#fef9c3;--ng:#9ca3af;--ngbg:#f3f4f6;--best:#f59e0b;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#1a1d23;--text:#e5e7eb;--muted:#9ca3af;--line:#2d323b;--accent:#2dd4bf;--accent2:#14b8a6;
--ok:#4ade80;--okbg:#14532d;--mid:#facc15;--midbg:#4a3d0a;--ng:#6b7280;--ngbg:#23272e;--danger:#f87171}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif;line-height:1.5;padding-bottom:env(safe-area-inset-bottom)}
.bar{background:var(--accent);padding:10px 16px}
.brand{color:#fff;text-decoration:none;font-weight:700}
@media (prefers-color-scheme:dark){.bar{background:#134e4a}}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:1.3rem;margin:4px 0 8px;word-break:break-word}
h2{font-size:1.05rem;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.muted{color:var(--muted);font-size:.88rem}
.center{text-align:center}
label.f{display:block;font-weight:600;margin:12px 0 6px}
input[type=text],textarea{width:100%;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
textarea{min-height:70px;resize:vertical}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1.5px solid var(--line);background:var(--card);color:var(--text);border-radius:999px;padding:8px 14px;font-size:15px;cursor:pointer;user-select:none}
.chip.on{border-color:var(--accent);background:var(--accent);color:#fff}
@media (prefers-color-scheme:dark){.chip.on{color:#042f2e}}
.chip small{opacity:.8;margin-left:4px;font-size:.75rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:12px;padding:12px 18px;font-size:16px;font-weight:700;cursor:pointer;background:var(--accent);color:#fff;text-decoration:none}
@media (prefers-color-scheme:dark){.btn{color:#042f2e}}
.btn.full{width:100%}
.btn.sub{background:var(--ngbg);color:var(--text)}
.btn.line{background:#06c755;color:#fff}
.btn.danger{background:transparent;color:var(--danger);border:1.5px solid var(--danger)}
.btn.small{padding:8px 12px;font-size:14px;border-radius:10px}
.btn:disabled{opacity:.5}
.row{display:flex;gap:8px;flex-wrap:wrap}
.row>.btn{flex:1}
.urlbox{display:flex;gap:6px;margin:6px 0 12px}
.urlbox input{font-size:14px}
.gridwrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
table.grid{border-collapse:separate;border-spacing:4px;width:100%;table-layout:fixed}
table.grid th{font-size:.8rem;font-weight:600;color:var(--muted);padding:2px}
table.grid th.day{font-size:.95rem;color:var(--text);cursor:pointer}
table.grid th.per{width:58px;text-align:left;cursor:pointer;line-height:1.15}
table.grid th.per b{display:block;color:var(--text);font-size:.95rem}
table.grid th.per span{font-size:.62rem;white-space:nowrap}
.cell{height:48px;border-radius:10px;border:0;width:100%;font-size:22px;font-weight:700;cursor:pointer;transition:transform .08s;-webkit-tap-highlight-color:transparent}
.cell:active{transform:scale(.94)}
.v2{background:var(--okbg);color:var(--ok)}
.v1{background:var(--midbg);color:var(--mid)}
.v0{background:var(--ngbg);color:var(--ng)}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:.85rem;color:var(--muted);margin:8px 0}
.legend b{font-size:1rem}
.res{height:52px;border-radius:10px;width:100%;border:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:.72rem;line-height:1.2;color:var(--text);position:relative}
.res .n{font-size:1.05rem;font-weight:800}
.res.best{outline:3px solid var(--best);outline-offset:-1px}
.res.best::after{content:"★";position:absolute;top:1px;right:4px;color:var(--best);font-size:.75rem}
.res.decided{outline:3px solid var(--accent);outline-offset:-1px}
.res.sel{box-shadow:0 0 0 3px var(--text) inset}
.detail{margin-top:10px;padding:12px;border-radius:10px;background:var(--bg);font-size:.92rem}
.detail .k{font-weight:700;margin-bottom:4px}
.names{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}
.names span{padding:2px 9px;border-radius:999px;font-size:.85rem}
.best-list{margin:0;padding-left:1.2em}
.best-list li{margin:4px 0}
.members{width:100%;border-collapse:collapse;font-size:.9rem}
.members td{padding:8px 4px;border-top:1px solid var(--line);vertical-align:top}
.members td:last-child{text-align:right;white-space:nowrap}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.8rem;font-weight:700}
.pill.closed{background:var(--ngbg);color:var(--muted)}
.pill.dec{background:var(--accent);color:#fff}
.banner{background:var(--okbg);color:var(--text);border-radius:12px;padding:12px 14px;margin-bottom:14px;font-weight:600}
.tabs{display:flex;gap:6px;margin-bottom:12px;position:sticky;top:0;z-index:5;background:var(--bg);padding:6px 0}
.tabs button{flex:1;padding:11px;border-radius:10px;border:1.5px solid var(--line);background:var(--card);color:var(--text);font-size:15px;font-weight:700;cursor:pointer}
.tabs button.on{border-color:var(--accent);color:var(--accent)}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(120px);background:#111827;color:#fff;padding:10px 16px;border-radius:999px;font-size:.9rem;transition:transform .2s,opacity .2s;opacity:0;pointer-events:none;z-index:20;max-width:90vw}
#toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.note{white-space:pre-wrap;word-break:break-word}
.recent a{color:var(--accent)}
`;
