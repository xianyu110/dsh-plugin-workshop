-- dsh-plugin-workshop 统计服务：D1 表结构（wrangler d1 execute 执行）
CREATE TABLE IF NOT EXISTS events (
  repo TEXT NOT NULL,
  event TEXT NOT NULL,
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_repo_day ON events(repo, day);

CREATE TABLE IF NOT EXISTS counters (
  repo TEXT PRIMARY KEY,
  installs INTEGER NOT NULL DEFAULT 0,
  updates INTEGER NOT NULL DEFAULT 0,
  uninstalls INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0
);
