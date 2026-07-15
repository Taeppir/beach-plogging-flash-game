-- 30초 해변 플로깅 — D1 스키마
-- 랭킹: 익명 uid당 최고 기록 1개
CREATE TABLE IF NOT EXISTS scores (
  uid   TEXT PRIMARY KEY,
  nick  TEXT NOT NULL,
  score INTEGER NOT NULL,
  ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC);

-- 데이터 활성화 지표용 행동 이벤트
CREATE TABLE IF NOT EXISTS events (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  uid  TEXT NOT NULL,
  sess TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  data TEXT,
  ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (name);
CREATE INDEX IF NOT EXISTS idx_events_uid  ON events (uid);
