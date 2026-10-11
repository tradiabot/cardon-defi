CREATE TABLE prices (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  usd REAL NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  technical TEXT NOT NULL,
  ai_action TEXT,
  ai_confidence REAL,
  ai_model TEXT,
  ai_reason TEXT,
  ai_error TEXT,
  final TEXT NOT NULL,
  blocked_by TEXT,
  features TEXT NOT NULL
);
CREATE INDEX decisions_ts ON decisions (ts DESC);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  side TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount_in REAL NOT NULL,
  amount_out REAL NOT NULL,
  price_usd REAL NOT NULL,
  cost_pct REAL NOT NULL,
  gas_usd REAL NOT NULL,
  realized_pnl_usd REAL,
  reason TEXT NOT NULL
);
CREATE INDEX trades_ts ON trades (ts DESC);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
