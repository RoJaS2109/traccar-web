import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = {
  TRACCAR_URL: 'https://traccar.test/',
  TRACCAR_SERVICE_EMAIL: 'servicio@rudatrak.invalid',
  TRACCAR_SERVICE_PASSWORD: 'contrasena-de-servicio',
  ENROLL_ADMIN_PASSWORD: 'una-clave-larga-de-verdad-24',
};

test('loadConfig aplica los valores por defecto', () => {
  const config = loadConfig(BASE);
  assert.equal(config.port, 3008);
  assert.equal(config.dbPath, './data/enroll.db');
  assert.equal(config.tokenDays, 45);
  assert.equal(config.adminUser, 'admin');
  assert.equal(config.codeTtlHours, 48);
  assert.equal(config.maxPending, 20);
  assert.equal(config.maxNoteLength, 200);
});

test('loadConfig normaliza la barra final de la URL', () => {
  assert.equal(loadConfig(BASE).traccarUrl, 'https://traccar.test');
});

test('loadConfig falla si falta una variable obligatoria', () => {
  const { TRACCAR_URL, ...incompleto } = BASE;
  assert.throws(() => loadConfig(incompleto), /TRACCAR_URL/);
});

test('loadConfig exige una clave de administrador larga', () => {
  assert.throws(
    () => loadConfig({ ...BASE, ENROLL_ADMIN_PASSWORD: 'corta' }),
    /al menos 24/,
  );
});

test('loadConfig limita la vida del token a entre 30 y 60 días', () => {
  assert.equal(loadConfig({ ...BASE, TOKEN_DAYS: '30' }).tokenDays, 30);
  assert.equal(loadConfig({ ...BASE, TOKEN_DAYS: '60' }).tokenDays, 60);
  assert.throws(() => loadConfig({ ...BASE, TOKEN_DAYS: '365' }), /entre 30 y 60/);
  assert.throws(() => loadConfig({ ...BASE, TOKEN_DAYS: '7' }), /entre 30 y 60/);
  assert.throws(() => loadConfig({ ...BASE, TOKEN_DAYS: 'treinta' }), /entre 30 y 60/);
});

test('loadConfig exige que la contraseña de servicio no sea trivial', () => {
  assert.throws(
    () => loadConfig({ ...BASE, TRACCAR_SERVICE_PASSWORD: 'corta' }),
    /contrasena-de-servicio|al menos 16/,
  );
});
