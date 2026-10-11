CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  side TEXT NOT NULL,
  trigger_price REAL NOT NULL,
  size_usd REAL NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  expires_ts INTEGER,
  trade_id INTEGER,
  note TEXT
);
CREATE INDEX orders_status ON orders (status, side);
ALTER TABLE trades ADD COLUMN order_id INTEGER;
