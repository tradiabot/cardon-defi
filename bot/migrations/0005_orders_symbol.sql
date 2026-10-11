-- Varios mercados: cada orden pertenece a uno. Las anteriores son todas de POL.
ALTER TABLE orders ADD COLUMN symbol TEXT NOT NULL DEFAULT 'POL';
CREATE INDEX orders_symbol ON orders (symbol, status);
