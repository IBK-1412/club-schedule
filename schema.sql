CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  days TEXT NOT NULL,
  periods TEXT NOT NULL,
  admin_key TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  decided TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  poll_id TEXT NOT NULL,
  name TEXT NOT NULL,
  answers TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  token TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (poll_id, name)
);
