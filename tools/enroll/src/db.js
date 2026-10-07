import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const PENDING = 'pending';
export const APPROVED = 'approved';
export const REVOKED = 'revoked';

/**
 * El secreto del dispositivo nunca se guarda. Solo este hash, que es la
 * clave primaria de la tabla.
 */
export function hashSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS devices (
      device_id       TEXT PRIMARY KEY,
      code            TEXT NOT NULL UNIQUE,
      status          TEXT NOT NULL,
      label           TEXT,
      note            TEXT,
      traccar_user_id INTEGER,
      created_at      TEXT NOT NULL,
      approved_at     TEXT,
      last_seen_at    TEXT,
      code_expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status);
  `);
  return db;
}

export function insertDevice(db, { deviceId, code, note, createdAt, codeExpiresAt }) {
  db.prepare(`
    INSERT INTO devices (device_id, code, status, note, created_at, code_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, code, PENDING, note ?? null, createdAt, codeExpiresAt);
}

export function getByDeviceId(db, deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) ?? null;
}

export function getByCode(db, code) {
  return db.prepare('SELECT * FROM devices WHERE code = ?').get(code) ?? null;
}

export function listByStatus(db, status) {
  return db.prepare('SELECT * FROM devices WHERE status = ? ORDER BY created_at DESC').all(status);
}

export function countByStatus(db, status) {
  return db.prepare('SELECT COUNT(*) AS n FROM devices WHERE status = ?').get(status).n;
}

/**
 * Primer tiempo de la aprobación. El `AND status` y el `AND traccar_user_id IS NULL`
 * son la carrera: de dos aprobaciones simultáneas, solo una escribe.
 * `changes === 1` significa "gané"; `0`, "ya lo aprobó otro".
 */
export function claimDevice(db, deviceId, traccarUserId, label) {
  const result = db.prepare(`
    UPDATE devices SET traccar_user_id = ?, label = ?
     WHERE device_id = ? AND status = ? AND traccar_user_id IS NULL
  `).run(traccarUserId, label, deviceId, PENDING);
  return result.changes === 1;
}

/** Segundo tiempo: pasa de pendiente a aprobado. También condicional. */
export function finalizeApproval(db, deviceId, approvedAt) {
  const result = db.prepare(`
    UPDATE devices SET status = ?, approved_at = ?
     WHERE device_id = ? AND status = ?
  `).run(APPROVED, approvedAt, deviceId, PENDING);
  return result.changes === 1;
}

export function markRevoked(db, deviceId) {
  const result = db.prepare('UPDATE devices SET status = ? WHERE device_id = ?')
    .run(REVOKED, deviceId);
  return result.changes === 1;
}

export function touch(db, deviceId, at) {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(at, deviceId);
}

export function deleteDevice(db, deviceId) {
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
}
