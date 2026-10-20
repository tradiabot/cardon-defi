-- Cardón Comunidad: registro voluntario (solo el correo) y reportes anónimos de errores y arreglos.
CREATE TABLE IF NOT EXISTS usuarios (
  email TEXT PRIMARY KEY,
  llave TEXT NOT NULL,          -- SHA-256 de la llave de borrado; la llave solo vive en el teléfono
  edicion TEXT NOT NULL,
  creado INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reportes (
  agente TEXT NOT NULL,         -- id aleatorio del agente, sin relación con wallet, cuenta ni correo
  codigo TEXT NOT NULL,
  arreglo TEXT NOT NULL,
  ok INTEGER NOT NULL,
  resuelto INTEGER NOT NULL,
  version TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reportes_codigo ON reportes (codigo, arreglo);
CREATE INDEX IF NOT EXISTS reportes_ts ON reportes (ts);
CREATE TABLE IF NOT EXISTS cupos (
  clave TEXT PRIMARY KEY,       -- SHA-256 de la IP o del agente + el día; se borra al día siguiente
  n INTEGER NOT NULL,
  dia INTEGER NOT NULL
);
