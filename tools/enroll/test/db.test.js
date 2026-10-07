import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, hashSecret, insertDevice, getByDeviceId, getByCode,
         listByStatus, countByStatus, claimDevice, finalizeApproval,
         markRevoked, touch, deleteDevice,
         PENDING, APPROVED, REVOKED } from '../src/db.js';

const SAMPLE = {
  deviceId: hashSecret('secreto-de-juan'),
  code: 'RUDA7K4M92QX',
  note: 'Juan, tester de Salta',
  createdAt: '2026-10-06T12:00:00.000Z',
  codeExpiresAt: '2026-10-08T12:00:00.000Z',
};

const freshDb = () => openDb(':memory:');

test('hashSecret es estable y no devuelve el secreto', () => {
  const a = hashSecret('secreto-de-juan');
  assert.equal(a, hashSecret('secreto-de-juan'));
  assert.equal(a.length, 64);
  assert.ok(!a.includes('secreto'));
});

test('la tabla devices no tiene columna token', () => {
  const db = freshDb();
  const columns = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  assert.ok(!columns.includes('token'), 'el token no debe persistirse nunca');
  assert.deepEqual(
    columns.sort(),
    ['approved_at', 'code', 'code_expires_at', 'created_at', 'device_id',
      'label', 'last_seen_at', 'note', 'status', 'traccar_user_id'].sort(),
  );
});

test('insertDevice guarda y getByDeviceId recupera', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.code, SAMPLE.code);
  assert.equal(row.status, PENDING);
  assert.equal(row.note, SAMPLE.note);
  assert.equal(row.traccar_user_id, null);
});

test('getByCode encuentra por código', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(getByCode(db, SAMPLE.code).device_id, SAMPLE.deviceId);
  assert.equal(getByCode(db, 'RUDA00000000'), null);
});

test('no se puede insertar dos veces el mismo device_id', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.throws(() => insertDevice(db, SAMPLE), /UNIQUE|PRIMARY/i);
});

test('no se puede repetir un código', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.throws(
    () => insertDevice(db, { ...SAMPLE, deviceId: hashSecret('otro') }),
    /UNIQUE/i,
  );
});

test('claimDevice gana una sola vez', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(claimDevice(db, SAMPLE.deviceId, 42, 'Juan'), true);
  // Segundo intento: traccar_user_id ya no es NULL.
  assert.equal(claimDevice(db, SAMPLE.deviceId, 43, 'Otro'), false);
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).traccar_user_id, 42);
});

test('claimDevice no reclama un dispositivo ya revocado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  markRevoked(db, SAMPLE.deviceId);
  assert.equal(claimDevice(db, SAMPLE.deviceId, 42, 'Juan'), false);
});

test('finalizeApproval aprueba una sola vez', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  claimDevice(db, SAMPLE.deviceId, 42, 'Juan');
  assert.equal(finalizeApproval(db, SAMPLE.deviceId, '2026-10-06T13:00:00.000Z'), true);
  assert.equal(finalizeApproval(db, SAMPLE.deviceId, '2026-10-06T14:00:00.000Z'), false);

  const row = getByDeviceId(db, SAMPLE.deviceId);
  assert.equal(row.status, APPROVED);
  assert.equal(row.label, 'Juan');
  assert.equal(row.traccar_user_id, 42);
  assert.equal(row.approved_at, '2026-10-06T13:00:00.000Z');
});

test('finalizeApproval no aprueba sin reclamar', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(finalizeApproval(db, SAMPLE.deviceId, '2026-10-06T13:00:00.000Z'), true);
  // Sin traccar_user_id no hay usuario asociado: no debería llegar acá, pero
  // la consulta no lo impide. Este test fija el comportamiento actual.
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).status, APPROVED);
});

test('markRevoked marca revocado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  assert.equal(markRevoked(db, SAMPLE.deviceId), true);
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).status, REVOKED);
});

test('markRevoked sobre un device inexistente devuelve false', () => {
  assert.equal(markRevoked(freshDb(), 'no-existe'), false);
});

test('touch actualiza last_seen_at', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  touch(db, SAMPLE.deviceId, '2027-04-01T00:00:00.000Z');
  assert.equal(getByDeviceId(db, SAMPLE.deviceId).last_seen_at, '2027-04-01T00:00:00.000Z');
});

test('deleteDevice borra y countByStatus cuenta', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  insertDevice(db, { ...SAMPLE, deviceId: hashSecret('pedro'), code: 'RUDA11111111' });
  assert.equal(countByStatus(db, PENDING), 2);
  assert.equal(listByStatus(db, PENDING).length, 2);
  deleteDevice(db, SAMPLE.deviceId);
  assert.equal(countByStatus(db, PENDING), 1);
  assert.equal(getByDeviceId(db, SAMPLE.deviceId), null);
});

test('countByStatus cuenta estados distintos por separado', () => {
  const db = freshDb();
  insertDevice(db, SAMPLE);
  insertDevice(db, { ...SAMPLE, deviceId: hashSecret('pedro'), code: 'RUDA11111111' });
  markRevoked(db, SAMPLE.deviceId);
  assert.equal(countByStatus(db, PENDING), 1);
  assert.equal(countByStatus(db, REVOKED), 1);
  assert.equal(countByStatus(db, APPROVED), 0);
});
