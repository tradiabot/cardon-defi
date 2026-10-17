-- Plan gratuito de D1: 5 millones de filas leídas al día.
-- Sin índice por ts, «DELETE FROM prices WHERE ts < ?» recorría toda la tabla (≈5 000 filas) en cada ciclo
-- y agotaba el límite diario; con estos índices cada ciclo lee solo las filas que borra o cuenta.
CREATE INDEX IF NOT EXISTS prices_ts ON prices (ts);
CREATE INDEX IF NOT EXISTS trades_mode_symbol_ts ON trades (mode, symbol, ts);
