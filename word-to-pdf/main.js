'use strict';

// Word to PDF
// vault に .docx / .doc が追加されたら PDF に変換して同じフォルダに保存し、
// ノート内のリンク（[[x.docx]] / ![[x.docx]] / [t](x.docx)）を PDF に置き換える。
// - 変換は PC だけ（Word の COM → だめなら LibreOffice）。iPad では何もしない。
//   iPad で入れた Word は同期で PC に届いた時点で PC が変換し、結果が同期で戻る。
// - 「この端末で変換する」などの端末ごとの設定は localStorage（同期で混ざらない）。

const { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath, Platform } = require('obsidian');

const WORD_EXT = new Set(['docx', 'doc']);
const DEFAULT_SHARED = {
  original: 'system-trash', // system-trash | obsidian-trash | keep
  replaceLinks: true,
};
const DEFAULT_LOCAL = {
  enabled: null,   // null = 既定（PC なら有効、モバイルは無効）
  method: 'auto',  // auto | word | libreoffice
  sofficePath: '',
};
const SETTLE_MS = 2500;        // 追加されたファイルの書き込みが落ち着くまで待つ
const TIMEOUT_MS = 180000;     // 1ファイルの変換の制限時間
const RELINK_RETRY_MS = 6000;  // 貼り付け直後はノートがまだ保存されていないことがあるので再度置換

function isWordFile(file) {
  if (!(file instanceof TFile)) return false;
  if (!WORD_EXT.has(file.extension.toLowerCase())) return false;
  if (file.name.startsWith('~$')) return false; // Word のロックファイル
  if (file.path.split('/').some((s) => s.startsWith('.'))) return false; // .trash など
  return true;
}

// リンク1個分の元テキストから、パス部分の拡張子だけを .pdf に変える
function relinkText(original) {
  const re = /\.docx?$/i;
  if (original.includes('[[')) {
    const start = original.indexOf('[[') + 2;
    const close = original.indexOf(']]', start);
    if (close < 0) return null;
    let end = close;
    for (const ch of ['|', '#']) {
      const i = original.indexOf(ch, start);
      if (i >= 0 && i < end) end = i;
    }
    const p = original.slice(start, end);
    if (!re.test(p)) return null;
    return original.slice(0, start) + p.replace(re, '.pdf') + original.slice(end);
  }
  const open = original.lastIndexOf('](');
  const close = original.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const start = open + 2;
  let end = close;
  let inner = original.slice(start, end);
  // <path with spaces> 形式と "title" 付きに対応
  let lead = 0;
  if (inner.startsWith('<')) { const gt = inner.indexOf('>'); if (gt > 0) { lead = 1; end = start + gt; } }
  else { const sp = inner.search(/\s/); if (sp >= 0) end = start + sp; }
  const hash = original.indexOf('#', start + lead);
  if (hash >= 0 && hash < end) end = hash;
  const p = original.slice(start + lead, end);
  if (!re.test(p)) return null;
  return original.slice(0, start + lead) + p.replace(re, '.pdf') + original.slice(end);
}

class WordToPdf extends Plugin {
  async onload() {
    this.shared = Object.assign({}, DEFAULT_SHARED, await this.loadData());
    this.local = Object.assign({}, DEFAULT_LOCAL, this.readLocal());
    this.timers = new Map();
    this.busy = new Set();
    this.queue = Promise.resolve();

    this.addSettingTab(new WordToPdfSettingTab(this.app, this));

    this.addCommand({
      id: 'convert-all',
      name: 'vault 内の Word ファイルをすべて PDF に変換',
      callback: () => this.convertAll(),
    });
    this.addCommand({
      id: 'convert-current',
      name: '開いている Word ファイルを PDF に変換',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !isWordFile(f) || !this.canConvert()) return false;
        if (!checking) this.enqueue(f, { manual: true });
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!isWordFile(file) || !this.canConvert()) return;
      menu.addItem((item) => item.setTitle('PDF に変換').setIcon('file-output')
        .onClick(() => this.enqueue(file, { manual: true })));
    }));

    // 起動時の読み込みで create が全ファイル分飛ぶので、準備完了後から監視する
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (f) => this.onNewFile(f)));
      this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
        // 拡張子なしで作られてから .docx に名前が変わる場合や、別フォルダから移動した場合
        if (isWordFile(f) && !/\.docx?$/i.test(oldPath)) this.onNewFile(f);
      }));
    });
  }

  onunload() {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
  }

  // ---------- 設定 ----------
  localKey() { return 'word-to-pdf-local'; }
  readLocal() {
    try {
      if (typeof this.app.loadLocalStorage === 'function') {
        const v = this.app.loadLocalStorage(this.localKey());
        if (v) return typeof v === 'string' ? JSON.parse(v) : v;
        return {};
      }
      const raw = window.localStorage.getItem((this.app.appId || this.app.vault.getName()) + '-' + this.localKey());
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  saveLocal() {
    try {
      if (typeof this.app.saveLocalStorage === 'function') {
        this.app.saveLocalStorage(this.localKey(), JSON.stringify(this.local));
      } else {
        window.localStorage.setItem((this.app.appId || this.app.vault.getName()) + '-' + this.localKey(), JSON.stringify(this.local));
      }
    } catch (e) { console.error('[word-to-pdf] saveLocal', e); }
  }
  async saveShared() { await this.saveData(this.shared); }

  canConvert() { return Platform.isDesktopApp && process.platform === 'win32'; }
  isEnabled() {
    if (!this.canConvert()) return false;
    return this.local.enabled === null || this.local.enabled === undefined ? true : !!this.local.enabled;
  }

  // ---------- 監視 ----------
  onNewFile(file) {
    if (!isWordFile(file) || !this.isEnabled()) return;
    const prev = this.timers.get(file.path);
    if (prev) window.clearTimeout(prev);
    this.timers.set(file.path, window.setTimeout(() => {
      this.timers.delete(file.path);
      this.waitStable(file).then((ok) => { if (ok) this.enqueue(file, { manual: false }); });
    }, SETTLE_MS));
  }

  async waitStable(file) {
    let last = -1;
    for (let i = 0; i < 20; i++) {
      const f = this.app.vault.getAbstractFileByPath(file.path);
      if (!(f instanceof TFile)) return false;
      const st = await this.app.vault.adapter.stat(f.path);
      const size = st ? st.size : -1;
      if (size > 0 && size === last) return true;
      last = size;
      await sleep(1000);
    }
    return true;
  }

  enqueue(file, opts) {
    this.queue = this.queue.then(() => this.convert(file, opts)).catch((e) => console.error('[word-to-pdf]', e));
    return this.queue;
  }

  async convertAll() {
    if (!this.canConvert()) { new Notice('この端末では変換できません（Windows PC のみ）'); return; }
    const files = this.app.vault.getFiles().filter(isWordFile);
    if (!files.length) { new Notice('Word ファイルはありません'); return; }
    new Notice(`${files.length} 個の Word ファイルを変換します`);
    for (const f of files) await this.enqueue(f, { manual: true });
  }

  // ---------- 変換本体 ----------
  pdfPathFor(file) {
    const dir = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
    return normalizePath(dir + file.basename + '.pdf');
  }

  availablePdfPath(file) {
    const dir = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
    let p = this.pdfPathFor(file);
    for (let i = 1; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${dir}${file.basename} ${i}.pdf`);
    return p;
  }

  async convert(file, { manual }) {
    const cur = this.app.vault.getAbstractFileByPath(file.path);
    if (!(cur instanceof TFile) || this.busy.has(file.path)) return;
    file = cur;
    this.busy.add(file.path);
    const plain = this.pdfPathFor(file);
    // 変換前から同名 PDF があるときは別名にする（既存の PDF を上書きしない）
    const target = this.app.vault.getAbstractFileByPath(plain) ? this.availablePdfPath(file) : plain;
    const notice = new Notice(`PDF に変換中: ${file.name}`, 0);
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2p-'));
    try {
      const base = this.app.vault.adapter.getBasePath();
      const src = path.join(base, ...file.path.split('/'));
      const out = await this.runConverter(src, tmpDir);
      const data = fs.readFileSync(out);
      if (!data.length) throw new Error('PDF が空でした');

      // 変換中に別の PC が先に変換して同期で届いた場合は、そちらを使う
      let pdfPath = target;
      if (target === plain && this.app.vault.getAbstractFileByPath(plain)) {
        console.log('[word-to-pdf] 他の端末が先に変換したので結果を捨てます', plain);
      } else {
        await this.app.vault.createBinary(target, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
      const pdf = this.app.vault.getAbstractFileByPath(pdfPath);

      let n = 0;
      if (this.shared.replaceLinks && pdf instanceof TFile) {
        n = await this.relink(file, pdf);
        // 貼り付け直後でまだノートが保存されていないリンクを拾うため、少し後にもう一度
        if (this.shared.original === 'keep') window.setTimeout(() => this.relink(file, pdf), RELINK_RETRY_MS);
      }
      if (this.shared.original !== 'keep') {
        if (this.shared.replaceLinks && pdf instanceof TFile) {
          await sleep(RELINK_RETRY_MS);
          n += await this.relink(file, pdf);
        }
        const f = this.app.vault.getAbstractFileByPath(file.path);
        if (f instanceof TFile) await this.app.vault.trash(f, this.shared.original === 'system-trash');
      }
      notice.hide();
      new Notice(`PDF にしました: ${pdfPath}${n ? `（リンク ${n} 件を置換）` : ''}`);
    } catch (e) {
      notice.hide();
      console.error('[word-to-pdf]', e);
      new Notice(`PDF 変換に失敗: ${file.name}\n${(e && e.message) || e}`, 10000);
    } finally {
      this.busy.delete(file.path);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  async runConverter(src, tmpDir) {
    const m = this.local.method || 'auto';
    const errors = [];
    if (m === 'auto' || m === 'word') {
      try { return await this.convertWithWord(src, tmpDir); } catch (e) { errors.push('Word: ' + e.message); if (m === 'word') throw e; }
    }
    if (m === 'auto' || m === 'libreoffice') {
      try { return await this.convertWithLibreOffice(src, tmpDir); } catch (e) { errors.push('LibreOffice: ' + e.message); }
    }
    throw new Error(errors.join(' / '));
  }

  // Word の COM で書き出す（新しい Word を裏で起動し、終わったら閉じる）。パスは環境変数で渡す（日本語や記号を含むパスでも壊れない）
  convertWithWord(src, tmpDir) {
    const path = require('path');
    const out = path.join(tmpDir, 'out.pdf');
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '$w = $null; $d = $null',
      'try {',
      '  $w = New-Object -ComObject Word.Application',
      '  $w.Visible = $false',
      '  $w.DisplayAlerts = 0',
      // Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
      '  $d = $w.Documents.Open($env:W2P_SRC, $false, $true, $false)',
      '  $d.ExportAsFixedFormat($env:W2P_OUT, 17)',
      '} finally {',
      '  if ($d -ne $null) { $d.Close(0) | Out-Null }',
      '  if ($w -ne $null) { $w.Quit() | Out-Null }',
      '}',
    ].join('\n');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { W2P_SRC: src, W2P_OUT: out }).then(() => this.mustExist(out));
  }

  convertWithLibreOffice(src, tmpDir) {
    const fs = require('fs');
    const path = require('path');
    const cands = [this.local.sofficePath,
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].filter(Boolean);
    const exe = cands.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
    if (!exe) return Promise.reject(new Error('LibreOffice が見つかりません'));
    // 別のプロファイルを使うと、ユーザーが LibreOffice を開いていても動く
    const profile = 'file:///' + path.join(tmpDir, 'profile').replace(/\\/g, '/');
    const ext = path.extname(src);
    const copy = path.join(tmpDir, 'in' + ext);
    fs.copyFileSync(src, copy);
    return this.run(exe, ['-env:UserInstallation=' + profile, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmpDir, copy], {})
      .then(() => this.mustExist(path.join(tmpDir, 'in.pdf')));
  }

  mustExist(p) {
    const fs = require('fs');
    if (!fs.existsSync(p)) throw new Error('PDF が作られませんでした');
    return p;
  }

  run(cmd, args, env) {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { env: Object.assign({}, process.env, env), timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || err.message;
            reject(new Error(msg));
          } else resolve(stdout);
        });
    });
  }

  // ---------- リンク置換 ----------
  async relink(word, pdf) {
    const mc = this.app.metadataCache;
    let total = 0;
    for (const md of this.app.vault.getMarkdownFiles()) {
      const resolved = mc.resolvedLinks[md.path];
      if (!resolved || !resolved[word.path]) continue;
      const cache = mc.getFileCache(md);
      if (!cache) continue;
      const items = [].concat(cache.links || [], cache.embeds || []);
      const reps = new Map();
      for (const l of items) {
        const dest = mc.getFirstLinkpathDest(l.link.split('#')[0], md.path);
        if (!dest || dest.path !== word.path) continue;
        let next = relinkText(l.original);
        if (!next) continue;
        // 同名 PDF が別にあって別名で保存したときは、パスを丸ごと新しい PDF にする
        if (pdf.basename !== word.basename) next = this.app.fileManager.generateMarkdownLink(pdf, md.path, '', l.displayText !== l.link ? l.displayText : undefined);
        if (l.original.startsWith('!') && !next.startsWith('!')) next = '!' + next;
        reps.set(l.original, next);
      }
      if (!reps.size) continue;
      let count = 0;
      await this.app.vault.process(md, (text) => {
        for (const [from, to] of reps) {
          const parts = text.split(from);
          count += parts.length - 1;
          text = parts.join(to);
        }
        return text;
      });
      total += count;
    }
    return total;
  }
}

function sleep(ms) { return new Promise((r) => window.setTimeout(r, ms)); }

class WordToPdfSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    if (!p.canConvert()) {
      containerEl.createEl('p', { text: 'この端末（iPad など）では変換しません。ここで入れた Word ファイルは、同期で Windows PC に届いた時点で PC が PDF にして、結果が同期で戻ってきます（PC の Obsidian が起動している必要があります）。' });
    }

    containerEl.createEl('h3', { text: 'この端末の設定' });
    new Setting(containerEl)
      .setName('この端末で変換する')
      .setDesc('Word ファイルが追加されたら自動で PDF にします。PC が複数台同時に起動していて二重に変換されるときは、片方をオフにしてください。')
      .addToggle((t) => t.setValue(p.isEnabled()).setDisabled(!p.canConvert()).onChange((v) => { p.local.enabled = v; p.saveLocal(); }));
    new Setting(containerEl)
      .setName('変換方法')
      .setDesc('自動: Word があれば Word、なければ LibreOffice。')
      .addDropdown((d) => d.addOptions({ auto: '自動', word: 'Microsoft Word', libreoffice: 'LibreOffice' })
        .setValue(p.local.method || 'auto').onChange((v) => { p.local.method = v; p.saveLocal(); }));
    new Setting(containerEl)
      .setName('LibreOffice の場所（任意）')
      .setDesc('空欄なら C:\\Program Files\\LibreOffice\\program\\soffice.exe を探します。')
      .addText((t) => t.setPlaceholder('soffice.exe のフルパス').setValue(p.local.sofficePath || '')
        .onChange((v) => { p.local.sofficePath = v.trim(); p.saveLocal(); }));

    containerEl.createEl('h3', { text: '共通の設定' });
    new Setting(containerEl)
      .setName('変換後の Word ファイル')
      .addDropdown((d) => d.addOptions({
        'system-trash': 'PC のごみ箱へ移動',
        'obsidian-trash': 'Obsidian のごみ箱（.trash）へ移動',
        keep: '残す',
      }).setValue(p.shared.original).onChange(async (v) => { p.shared.original = v; await p.saveShared(); }));
    new Setting(containerEl)
      .setName('ノート内のリンクを PDF に置き換える')
      .setDesc('[[資料.docx]] や ![[資料.docx]] を [[資料.pdf]] に書き換えます。')
      .addToggle((t) => t.setValue(p.shared.replaceLinks).onChange(async (v) => { p.shared.replaceLinks = v; await p.saveShared(); }));

    new Setting(containerEl)
      .setName('今ある Word ファイルを変換')
      .setDesc('自動変換は、このプラグインを入れた後に追加されたファイルだけが対象です。')
      .addButton((b) => b.setButtonText('すべて変換').setDisabled(!p.canConvert()).onClick(() => p.convertAll()));
  }
}

module.exports = WordToPdf;
module.exports.relinkText = relinkText;
