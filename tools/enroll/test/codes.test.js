import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, normalizeCode, formatCode } from '../src/codes.js';

test('generateCode tiene el prefijo y el largo esperados', () => {
  assert.match(generateCode(), /^RUDA[A-Z0-9]{8}$/);
});

test('generateCode no usa caracteres ambiguos', () => {
  // Con 2000 códigos, si el alfabeto incluyera I, O, 0 o 1 la probabilidad
  // de no verlos es despreciable.
  const todos = Array.from({ length: 2000 }, () => generateCode().slice(4)).join('');
  for (const ambiguo of ['I', 'O', '0', '1']) {
    assert.ok(!todos.includes(ambiguo), `el alfabeto no debe incluir ${ambiguo}`);
  }
});

test('generateCode usa el generador inyectado', () => {
  assert.equal(generateCode(() => 0), 'RUDAAAAAAAAA');
});

test('normalizeCode tolera minúsculas, espacios y guiones', () => {
  assert.equal(normalizeCode('ruda-7k4m-92qx'), 'RUDA7K4M92QX');
  assert.equal(normalizeCode('  RUDA 7K4M 92QX \n'), 'RUDA7K4M92QX');
  assert.equal(normalizeCode('RUDA7K4M92QX'), 'RUDA7K4M92QX');
});

test('normalizeCode no explota con vacío, null ni undefined', () => {
  assert.equal(normalizeCode(''), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
});

test('formatCode inserta los guiones para mostrar', () => {
  assert.equal(formatCode('RUDA7K4M92QX'), 'RUDA-7K4M-92QX');
  assert.equal(formatCode('ruda-7k4m-92qx'), 'RUDA-7K4M-92QX');
});

test('formatCode devuelve lo que recibe si no tiene la forma esperada', () => {
  assert.equal(formatCode('cualquier-cosa'), 'CUALQUIERCOSA');
  assert.equal(formatCode(''), '');
});

test('ida y vuelta: formatCode y normalizeCode son inversas', () => {
  const code = generateCode();
  assert.equal(normalizeCode(formatCode(code)), code);
});
