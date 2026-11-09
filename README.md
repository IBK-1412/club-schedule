# 部活の予定調整（曜日 × 1〜6限）

Cloudflare Workers + D1。ログイン不要、URL を LINE で共有して ○△× を投票。

## 初回デプロイ
```
npx wrangler d1 create club-schedule      # 出た database_id を wrangler.toml に書く
npx wrangler d1 execute club-schedule --remote --file schema.sql
npx wrangler deploy
```
更新は `npx wrangler deploy` だけ。

- 作成者には管理用URL（?admin=…）が出る。締切・決定・回答削除・タイトル編集・削除ができる。部員には送らない。
- 回答は名前単位。同じ名前で回答すると上書き。回答済みの名前をタップすると編集できる。
- 時限の時間は src/worker.js の PERIODS。
