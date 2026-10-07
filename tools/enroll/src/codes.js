import { randomInt } from 'node:crypto';

// Sin I, O, 0 ni 1: son los que se confunden al dictar un código por teléfono
// o al copiarlo de una captura de pantalla.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'RUDA';
const BODY_LENGTH = 8;

/**
 * Devuelve el código en forma canónica: mayúsculas, sin separadores.
 * Los guiones son presentación, no parte del dato.
 */
export function generateCode(random = randomInt) {
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    body += ALPHABET[random(ALPHABET.length)];
  }
  return PREFIX + body;
}

/**
 * Deja cualquier entrada humana en forma canónica. Acepta minúsculas,
 * espacios, guiones y saltos de línea: lo que sale de un mensaje de
 * WhatsApp pegado en el formulario.
 */
export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Presentación: RUDA-7K4M-92QX */
export function formatCode(code) {
  const canonical = normalizeCode(code);
  if (!/^RUDA[A-Z0-9]{8}$/.test(canonical)) {
    return canonical;
  }
  return `${canonical.slice(0, 4)}-${canonical.slice(4, 8)}-${canonical.slice(8, 12)}`;
}
