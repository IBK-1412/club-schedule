const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SYM = ['×', '△', '○'];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
async function api(path, opt) {
  const r = await fetch(path, opt && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opt) });
  const j = await r.json().catch(() => ({ error: '通信エラー' }));
  if (!r.ok) throw new Error(j.error || '通信エラー');
  return j;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('コピーしました'); } catch (e2) { prompt('コピーしてください', text); }
    ta.remove();
  }
}
function lineShare(text) {
  location.href = 'https://line.me/R/share?text=' + encodeURIComponent(text);
}
const slotLabel = (k) => { const [d, p] = k.split('-'); return DAY_NAMES[d] + '曜' + p + '限'; };
const slotTime = (k) => PERIODS[k.split('-')[1]];

// ---------- 作成画面 ----------
function renderCreate() {
  document.title = '予定調整をつくる';
  const st = { days: [0, 1, 2, 3, 4], periods: [1, 2, 3, 4, 5, 6] };
  const recent = store.get('recentPolls', []);
  app.innerHTML = `
  <div class="card">
    <h1>部活の予定調整をつくる</h1>
    <p class="muted">曜日 × 授業時限（1〜6限）で、部員が ○△× を付けて投票できます。作ったURLをLINEで送るだけ。ログイン不要です。</p>
    <label class="f" for="title">タイトル</label>
    <input type="text" id="title" maxlength="60" placeholder="例：後期 週1ミーティングの時間">
    <label class="f">候補の曜日</label>
    <div class="chips" id="days"></div>
    <label class="f">候補の時限</label>
    <div class="chips" id="pers"></div>
    <label class="f" for="note">メモ（任意）</label>
    <textarea id="note" maxlength="500" placeholder="例：11/20までに回答お願いします！ 場所は部室です"></textarea>
    <div style="margin-top:16px"><button class="btn full" id="go">作成する</button></div>
  </div>
  ${recent.length ? '<div class="card recent"><h2>最近つくった・答えた予定調整</h2>' + recent.map((r) => '<div style="margin:6px 0"><a href="' + h(r.url) + '">' + h(r.title) + '</a>' + (r.admin ? ' <span class="muted">（管理者）</span>' : '') + '</div>').join('') + '</div>' : ''}
  `;
  const drawChips = () => {
    $('#days').innerHTML = DAY_NAMES.map((n, i) => '<span class="chip ' + (st.days.includes(i) ? 'on' : '') + '" data-d="' + i + '">' + n + '</span>').join('');
    $('#pers').innerHTML = Object.keys(PERIODS).map((p) => '<span class="chip ' + (st.periods.includes(+p) ? 'on' : '') + '" data-p="' + p + '">' + p + '限<small>' + PERIODS[p] + '</small></span>').join('');
  };
  drawChips();
  const tog = (arr, v) => { const i = arr.indexOf(v); i < 0 ? arr.push(v) : arr.splice(i, 1); };
  $('#days').onclick = (e) => { const c = e.target.closest('[data-d]'); if (c) { tog(st.days, +c.dataset.d); drawChips(); } };
  $('#pers').onclick = (e) => { const c = e.target.closest('[data-p]'); if (c) { tog(st.periods, +c.dataset.p); drawChips(); } };
  $('#go').onclick = async () => {
    const title = $('#title').value.trim();
    if (!title) { toast('タイトルを入れてください'); $('#title').focus(); return; }
    if (!st.days.length || !st.periods.length) { toast('曜日と時限を1つ以上選んでください'); return; }
    $('#go').disabled = true;
    try {
      const r = await api('/api/polls', { title, note: $('#note').value, days: st.days, periods: st.periods });
      const adminUrl = '/p/' + r.id + '?admin=' + r.adminKey;
      remember({ id: r.id, title, url: adminUrl, admin: true });
      history.pushState(null, '', adminUrl);
      route(true);
    } catch (e) { toast(e.message); $('#go').disabled = false; }
  };
}

function remember(entry) {
  const list = store.get('recentPolls', []).filter((x) => x.id !== entry.id);
  const old = store.get('recentPolls', []).find((x) => x.id === entry.id);
  if (old && old.admin && !entry.admin) entry = old; // 管理URLを上書きしない
  list.unshift(entry);
  store.set('recentPolls', list.slice(0, 10));
}

// ---------- 投票・集計画面 ----------
let S = null; // { poll, adminKey, tab, my:{name,answers,comment}, sel }

async function renderPoll(id, justCreated) {
  const adminKey = new URLSearchParams(location.search).get('admin') || '';
  let poll;
  try { poll = await api('/api/polls/' + id + (adminKey ? '?admin=' + encodeURIComponent(adminKey) : '')); }
  catch (e) { app.innerHTML = '<div class="card center"><p>' + h(e.message) + '</p><a class="btn" href="/">新しく作る</a></div>'; return; }
  const toks = store.get('toks:' + id, {});
  const me = store.get('me:' + id, null);
  if (me && !toks[me]) toks[me] = 'legacy'; // 更新前に回答した端末
  const mine = me && poll.votes.find((v) => v.name === me);
  const savedName = store.get('myName', '');
  S = {
    poll, adminKey: poll.isAdmin ? adminKey : '', justCreated,
    tab: S && S.poll && S.poll.id === id ? S.tab : (mine || poll.closed ? 'res' : 'vote'),
    my: mine ? { name: mine.name, oldName: mine.name, answers: Object.assign({}, mine.answers), comment: mine.comment }
             : { name: (S && S.my && S.poll && S.poll.id === id) ? S.my.name : savedName, oldName: '', answers: {}, comment: '' },
    sel: null,
  };
  if (justCreated) S.tab = 'share';
  remember({ id, title: poll.title, url: '/p/' + id + (S.adminKey ? '?admin=' + S.adminKey : ''), admin: !!S.adminKey });
  draw();
}

function shareUrl() { return location.origin + '/p/' + S.poll.id; }
function shareText() { return '【予定調整】' + S.poll.title + '\n空いている授業時間に ○△× をつけてください！\n' + shareUrl(); }

function draw() {
  const p = S.poll;
  document.title = p.title + '｜予定調整';
  const tabs = [['vote', p.closed ? '回答（締切）' : '回答する'], ['res', '集計 (' + p.votes.length + '人)']];
  if (S.adminKey) tabs.push(['share', '共有・管理']);
  app.innerHTML = `
    <h1>${h(p.title)} ${p.closed ? '<span class="pill closed">締切</span>' : ''}</h1>
    ${p.note ? '<p class="note muted" style="margin-top:0">' + h(p.note) + '</p>' : ''}
    ${p.decided ? '<div class="banner">✅ 決定：' + slotLabel(p.decided) + '（' + slotTime(p.decided) + '）</div>' : ''}
    <div class="tabs">${tabs.map(([k, n]) => '<button data-tab="' + k + '" class="' + (S.tab === k ? 'on' : '') + '">' + n + '</button>').join('')}</div>
    <div id="body"></div>
  `;
  app.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; draw(); window.scrollTo(0, 0); } };
  ({ vote: drawVote, res: drawRes, share: drawShare })[S.tab]();
}

function gridHead(p) {
  return '<tr><th class="per"></th>' + p.days.map((d) => '<th class="day" data-col="' + d + '">' + DAY_NAMES[d] + '</th>').join('') + '</tr>';
}
function perHead(per) {
  return '<th class="per" data-row="' + per + '"><b>' + per + '限</b><span>' + PERIODS[per].replace('〜', '-') + '</span></th>';
}

function drawVote() {
  const p = S.poll, my = S.my, B = $('#body');
  if (p.closed) {
    B.innerHTML = '<div class="card center"><p>この投票は締め切られました。</p><button class="btn" data-go="res">集計を見る</button></div>';
    B.querySelector('[data-go]').onclick = () => { S.tab = 'res'; draw(); };
    return;
  }
  const toks = store.get('toks:' + p.id, {});
  const legacyMe = store.get('me:' + p.id, null);
  if (legacyMe && !toks[legacyMe]) toks[legacyMe] = 'legacy';
  // この端末で回答した名前（管理者は全員分）だけ編集できる
  const editable = p.votes.map((v) => v.name).filter((n) => n !== my.oldName && (S.adminKey || toks[n]));
  B.innerHTML = `
  <div class="card">
    <label class="f" for="nm" style="margin-top:0">名前</label>
    <input type="text" id="nm" maxlength="20" placeholder="例：山田" value="${h(my.name)}" autocomplete="nickname">
    ${my.oldName ? '<p class="muted" style="margin:6px 0 0">「' + h(my.oldName) + '」の回答を編集中です。<a href="#" id="fresh">別の人として新しく回答する</a></p>' : ''}
    ${editable.length ? '<p class="muted" style="margin:6px 0 0">' + (S.adminKey ? '回答を編集（管理者）：' : 'この端末で回答した名前：') + editable.map((n) => '<a href="#" data-edit="' + h(n) + '">' + h(n) + '</a>').join('、') + '<br>（タップすると、その回答を編集できます）</p>' : ''}
  </div>
  <div class="card">
    <h2>空いている時間をタップ</h2>
    <div class="legend"><span><b class="v2" style="padding:0 6px;border-radius:6px">○</b> 参加できる</span><span><b class="v1" style="padding:0 6px;border-radius:6px">△</b> たぶん／遅れる</span><span><b class="v0" style="padding:0 6px;border-radius:6px">×</b> 無理</span></div>
    <p class="muted" style="margin:0 0 6px">タップで ×→○→△ と切り替わります。曜日・時限の見出しをタップすると列・行をまとめて切り替え。</p>
    <div class="gridwrap"><table class="grid" id="vg">
      <thead>${gridHead(p)}</thead>
      <tbody>${p.periods.map((per) => '<tr>' + perHead(per) + p.days.map((d) => {
        const k = d + '-' + per, v = my.answers[k] || 0;
        return '<td><button class="cell v' + v + '" data-k="' + k + '" aria-label="' + DAY_NAMES[d] + '曜' + per + '限 ' + SYM[v] + '">' + SYM[v] + '</button></td>';
      }).join('') + '</tr>').join('')}</tbody>
    </table></div>
    <div class="row" style="margin-top:10px">
      <button class="btn sub small" id="allok">全部○</button>
      <button class="btn sub small" id="allng">全部×</button>
    </div>
    <label class="f" for="cm">ひとこと（任意）</label>
    <input type="text" id="cm" maxlength="200" placeholder="例：火曜はバイトで遅れます" value="${h(my.comment)}">
    <div style="margin-top:16px"><button class="btn full" id="save">${my.oldName ? '回答を更新する' : '回答する'}</button></div>
  </div>
  `;
  const NEXT = { 0: 2, 2: 1, 1: 0 };
  const paint = () => B.querySelectorAll('.cell').forEach((c) => {
    const v = my.answers[c.dataset.k] || 0; c.className = 'cell v' + v; c.textContent = SYM[v];
  });
  const cycleSet = (keys) => {
    const cur = keys.map((k) => my.answers[k] || 0);
    const allSame = cur.every((v) => v === cur[0]);
    const nv = allSame ? NEXT[cur[0]] : 2;
    keys.forEach((k) => (my.answers[k] = nv)); paint();
  };
  $('#vg').onclick = (e) => {
    const c = e.target.closest('[data-k]');
    if (c) { const k = c.dataset.k; my.answers[k] = NEXT[my.answers[k] || 0]; paint(); return; }
    const col = e.target.closest('[data-col]');
    if (col) return cycleSet(p.periods.map((per) => col.dataset.col + '-' + per));
    const row = e.target.closest('[data-row]');
    if (row) return cycleSet(p.days.map((d) => d + '-' + row.dataset.row));
  };
  const setAll = (v) => { p.days.forEach((d) => p.periods.forEach((per) => (my.answers[d + '-' + per] = v))); paint(); };
  $('#allok').onclick = () => setAll(2);
  $('#allng').onclick = () => setAll(0);
  $('#nm').oninput = (e) => (my.name = e.target.value);
  $('#cm').oninput = (e) => (my.comment = e.target.value);
  B.querySelectorAll('[data-edit]').forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    const v = p.votes.find((x) => x.name === a.dataset.edit);
    if (!v) return;
    S.my = { name: v.name, oldName: v.name, answers: Object.assign({}, v.answers), comment: v.comment };
    drawVote(); toast('「' + v.name + '」の回答を読み込みました');
  });
  const fresh = $('#fresh');
  if (fresh) fresh.onclick = (e) => {
    e.preventDefault();
    S.my = { name: '', oldName: '', answers: {}, comment: '' };
    drawVote();
  };
  $('#save').onclick = async () => {
    const name = my.name.trim();
    if (!name) { toast('名前を入れてください'); $('#nm').focus(); return; }
    const canOverwrite = S.adminKey || toks[name];
    if (name !== my.oldName && p.votes.some((v) => v.name === name)) {
      if (!canOverwrite) { toast('「' + name + '」はすでに回答があります。別の名前にしてください'); $('#nm').focus(); return; }
      if (!confirm('「' + name + '」の回答を上書きしますか？')) return;
    }
    $('#save').disabled = true;
    try {
      const r = await api('/api/polls/' + p.id + '/votes', {
        name, oldName: my.oldName, answers: my.answers, comment: my.comment,
        token: [toks[my.oldName], toks[name]].find((t) => t && t !== 'legacy') || '',
        claim: toks[my.oldName] === 'legacy' ? my.oldName : toks[name] === 'legacy' ? name : '',
        adminKey: S.adminKey || undefined,
      });
      const t2 = store.get('toks:' + p.id, {});
      if (my.oldName && my.oldName !== name) delete t2[my.oldName];
      if (r.token) { t2[name] = r.token; store.set('me:' + p.id, name); store.set('myName', name); }
      store.set('toks:' + p.id, t2);
      toast('回答を保存しました');
      S.tab = 'res';
      await renderPoll(p.id);
    } catch (e) { toast(e.message); $('#save').disabled = false; }
  };
}

function tally(p) {
  const t = {};
  for (const d of p.days) for (const per of p.periods) t[d + '-' + per] = { ok: [], mid: [], ng: [] };
  for (const v of p.votes) for (const k in t) {
    const a = v.answers[k] || 0;
    t[k][a === 2 ? 'ok' : a === 1 ? 'mid' : 'ng'].push(v.name);
  }
  return t;
}

function drawRes() {
  const p = S.poll, B = $('#body'), t = tally(p), n = p.votes.length;
  const keys = Object.keys(t);
  const score = (k) => t[k].ok.length * 2 + t[k].mid.length;
  const maxScore = Math.max(0, ...keys.map(score));
  const ranked = keys.filter((k) => score(k) > 0).sort((a, b) => score(b) - score(a) || t[b].ok.length - t[a].ok.length);
  const best = ranked.filter((k) => score(k) === maxScore);
  const top = ranked.slice(0, 5);
  if (!n) {
    B.innerHTML = '<div class="card center"><p>まだ回答がありません。</p>' + (p.closed ? '' : '<button class="btn" data-go="vote">最初に回答する</button>') + '</div>' + (S.adminKey ? '' : shareCard());
    const g = B.querySelector('[data-go]'); if (g) g.onclick = () => { S.tab = 'vote'; draw(); };
    bindShare(B);
    return;
  }
  const bg = (k) => {
    if (!n) return 'var(--ngbg)';
    const r = score(k) / (2 * n);
    return 'color-mix(in srgb, var(--accent2) ' + Math.round(r * 85) + '%, var(--ngbg))';
  };
  B.innerHTML = `
  <div class="card">
    <h2>おすすめの時間</h2>
    ${top.length ? '<ol class="best-list">' + top.map((k) => '<li><b>' + slotLabel(k) + '</b> <span class="muted">' + slotTime(k) + '</span><br><span class="muted">○' + t[k].ok.length + ' △' + t[k].mid.length + ' ×' + t[k].ng.length + (t[k].ng.length && t[k].ng.length <= 3 ? '（×：' + t[k].ng.map(h).join('、') + '）' : '') + '</span></li>').join('') + '</ol>' : '<p class="muted">○や△がついた時間はまだありません。</p>'}
  </div>
  <div class="card">
    <h2>全体の表 <span class="muted" style="font-weight:400">（${n}人回答）</span></h2>
    <p class="muted" style="margin:0 0 6px">数字は ○ の人数（＋△）。色が濃いほど集まりやすい時間。★が最有力。マスをタップで名前を表示。</p>
    <div class="gridwrap"><table class="grid" id="rg">
      <thead>${gridHead(p)}</thead>
      <tbody>${p.periods.map((per) => '<tr>' + perHead(per) + p.days.map((d) => {
        const k = d + '-' + per, c = t[k];
        const cls = ['res'];
        if (p.decided === k) cls.push('decided'); else if (best.includes(k) && maxScore > 0) cls.push('best');
        if (S.sel === k) cls.push('sel');
        return '<td><button class="' + cls.join(' ') + '" style="background:' + bg(k) + '" data-k="' + k + '"><span class="n">' + c.ok.length + '</span>' + (c.mid.length ? '<span>+△' + c.mid.length + '</span>' : '<span>&nbsp;</span>') + '</button></td>';
      }).join('') + '</tr>').join('')}</tbody>
    </table></div>
    <div id="det"></div>
  </div>
  <div class="card">
    <h2>回答した人</h2>
    <table class="members">${p.votes.map((v) => {
      const c = Object.values(v.answers).filter((x) => x === 2).length;
      return '<tr><td><b>' + h(v.name) + '</b>' + (v.comment ? '<div class="muted">' + h(v.comment) + '</div>' : '') + '</td><td class="muted">○' + c + 'コマ' +
        (S.adminKey ? ' <button class="btn danger small" data-del="' + h(v.name) + '" style="margin-left:6px;padding:4px 8px">削除</button>' : '') + '</td></tr>';
    }).join('')}</table>
  </div>
  ${S.adminKey ? '' : shareCard()}
  `;
  const showDet = () => {
    const k = S.sel, det = $('#det');
    if (!k) { det.innerHTML = ''; return; }
    const c = t[k];
    const list = (arr, cls) => arr.length ? '<div class="names">' + arr.map((x) => '<span class="' + cls + '">' + h(x) + '</span>').join('') + '</div>' : '<div class="muted" style="margin-bottom:8px">なし</div>';
    det.innerHTML = '<div class="detail"><div class="k">' + slotLabel(k) + '（' + slotTime(k) + '）</div>' +
      '○ 参加できる' + list(c.ok, 'v2') + '△ たぶん' + list(c.mid, 'v1') + '× 無理' + list(c.ng, 'v0') +
      (S.adminKey ? '<button class="btn small" id="dec">' + (p.decided === k ? '決定を取り消す' : 'この時間に決定する') + '</button>' : '') + '</div>';
    const dec = $('#dec');
    if (dec) dec.onclick = () => adminAct({ action: 'decide', value: p.decided === k ? '' : k }, p.decided === k ? '決定を取り消しました' : '決定しました');
  };
  $('#rg').onclick = (e) => {
    const c = e.target.closest('[data-k]'); if (!c) return;
    S.sel = S.sel === c.dataset.k ? null : c.dataset.k;
    B.querySelectorAll('#rg .res').forEach((x) => x.classList.toggle('sel', x.dataset.k === S.sel));
    showDet();
  };
  showDet();
  B.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    if (confirm('「' + b.dataset.del + '」の回答を削除しますか？')) adminAct({ action: 'deleteVote', name: b.dataset.del }, '削除しました');
  });
  bindShare(B);
}

function shareCard() {
  return '<div class="card"><h2>みんなに送る</h2><div class="row"><button class="btn line" data-share="line">LINEで送る</button><button class="btn sub" data-share="copy">URLをコピー</button></div></div>';
}
function bindShare(root) {
  root.querySelectorAll('[data-share]').forEach((b) => b.onclick = () => {
    if (b.dataset.share === 'line') lineShare(shareText());
    else if (b.dataset.share === 'copy') copy(shareUrl());
    else if (b.dataset.share === 'copyadmin') copy(location.origin + '/p/' + S.poll.id + '?admin=' + S.adminKey);
  });
}

async function adminAct(body, msg) {
  try {
    await api('/api/polls/' + S.poll.id + '/admin', Object.assign({ adminKey: S.adminKey }, body));
    toast(msg);
    await renderPoll(S.poll.id);
  } catch (e) { toast(e.message); }
}

function drawShare() {
  const p = S.poll, B = $('#body');
  const adminUrl = location.origin + '/p/' + p.id + '?admin=' + S.adminKey;
  B.innerHTML = `
  ${S.justCreated ? '<div class="banner">🎉 作成しました！下のボタンからLINEで部員に送ってください。</div>' : ''}
  <div class="card">
    <h2>部員に送る</h2>
    <p class="muted" style="margin:0">このURLを開けば、ログインなしで回答・集計の確認ができます。</p>
    <div class="urlbox"><input type="text" readonly value="${h(shareUrl())}" onclick="this.select()"><button class="btn sub small" data-share="copy">コピー</button></div>
    <button class="btn line full" data-share="line">LINEで送る</button>
  </div>
  <div class="card">
    <h2>管理用URL（自分だけ）</h2>
    <p class="muted" style="margin:0">締切・決定・回答の削除ができるURLです。<b>部員には送らないでください。</b>この端末には自動で保存されます（トップ画面の「最近つくった」から開けます）。別の端末でも管理したいときは、自分のLINE（Keepメモなど）に保存してください。</p>
    <div class="urlbox"><input type="text" readonly value="${h(adminUrl)}" onclick="this.select()"><button class="btn sub small" data-share="copyadmin">コピー</button></div>
  </div>
  <div class="card">
    <h2>管理</h2>
    <label class="f" for="et" style="margin-top:0">タイトル</label>
    <input type="text" id="et" maxlength="60" value="${h(p.title)}">
    <label class="f" for="en">メモ</label>
    <textarea id="en" maxlength="500">${h(p.note)}</textarea>
    <div style="margin:10px 0 16px"><button class="btn sub small" id="esave">タイトル・メモを保存</button></div>
    <div class="row">
      <button class="btn sub" id="close">${p.closed ? '回答を再開する' : '回答を締め切る'}</button>
    </div>
    <p class="muted">時間を決めるときは「集計」タブでマスをタップ →「この時間に決定する」。</p>
    <div style="margin-top:18px"><button class="btn danger full" id="delpoll">この予定調整を削除</button></div>
  </div>
  `;
  bindShare(B);
  $('#esave').onclick = () => adminAct({ action: 'edit', title: $('#et').value, note: $('#en').value }, '保存しました');
  $('#close').onclick = () => adminAct({ action: 'close', value: !p.closed }, p.closed ? '再開しました' : '締め切りました');
  $('#delpoll').onclick = async () => {
    if (!confirm('この予定調整と全員の回答を削除します。元に戻せません。よろしいですか？')) return;
    try {
      await api('/api/polls/' + p.id + '/admin', { adminKey: S.adminKey, action: 'deletePoll' });
      store.set('recentPolls', store.get('recentPolls', []).filter((x) => x.id !== p.id));
      history.pushState(null, '', '/'); route();
      toast('削除しました');
    } catch (e) { toast(e.message); }
  };
}

function route(justCreated) {
  const m = location.pathname.match(/^\/p\/([A-Za-z0-9]+)$/);
  if (m) renderPoll(m[1], justCreated === true); else renderCreate();
}
window.addEventListener('popstate', () => route());
route();
