const DEFAULT_PORT = 3008;
const DEFAULT_DB_PATH = './data/enroll.db';
const DEFAULT_TOKEN_DAYS = 45;
const DEFAULT_CODE_TTL_HOURS = 48;
const DEFAULT_MAX_PENDING = 20;
const DEFAULT_MAX_NOTE_LENGTH = 200;
const MIN_ADMIN_PASSWORD = 24;
const MIN_SERVICE_PASSWORD = 16;
const MIN_TOKEN_DAYS = 30;
const MAX_TOKEN_DAYS = 60;

const REQUIRED = [
  'TRACCAR_URL',
  'TRACCAR_SERVICE_EMAIL',
  'TRACCAR_SERVICE_PASSWORD',
  'ENROLL_ADMIN_PASSWORD',
];

function integerInRange(raw, fallback, min, max, label) {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

/**
 * Lee y valida la configuración. Falla al arrancar, no en la primera petición:
 * un servicio mal configurado que igual levanta es peor que uno que no arranca.
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }

  // La clave del panel se usa como Basic auth. Una clave corta se rompe por
  // fuerza bruta en minutos, y el panel no tiene segundo factor.
  if (String(env.ENROLL_ADMIN_PASSWORD).length < MIN_ADMIN_PASSWORD) {
    throw new Error(`ENROLL_ADMIN_PASSWORD debe tener al menos ${MIN_ADMIN_PASSWORD} caracteres`);
  }
  if (String(env.TRACCAR_SERVICE_PASSWORD).length < MIN_SERVICE_PASSWORD) {
    throw new Error(`TRACCAR_SERVICE_PASSWORD debe tener al menos ${MIN_SERVICE_PASSWORD} caracteres`);
  }

  return {
    port: integerInRange(env.PORT, DEFAULT_PORT, 1, 65535, 'PORT'),
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    backupDir: env.BACKUP_DIR || './backups',
    backupKeep: integerInRange(env.BACKUP_KEEP, 7, 1, 90, 'BACKUP_KEEP'),
    traccarUrl: String(env.TRACCAR_URL).replace(/\/+$/, ''),
    serviceEmail: env.TRACCAR_SERVICE_EMAIL,
    servicePassword: env.TRACCAR_SERVICE_PASSWORD,
    adminUser: env.ENROLL_ADMIN_USER || 'admin',
    adminPassword: env.ENROLL_ADMIN_PASSWORD,
    codeTtlHours: integerInRange(env.CODE_TTL_HOURS, DEFAULT_CODE_TTL_HOURS, 1, 24 * 14, 'CODE_TTL_HOURS'),
    // Tope de pedidos sin aprobar. /enroll/request es público, así que sin esto
    // cualquiera puede llenar la base de filas pendientes.
    maxPending: integerInRange(env.MAX_PENDING, DEFAULT_MAX_PENDING, 1, 500, 'MAX_PENDING'),
    // La nota la escribe una persona en un formulario y Rodrigo la lee para saber
    // quién pide acceso. No hace falta más, y un campo libre sin tope es un lugar
    // donde entra cualquier cosa.
    maxNoteLength: integerInRange(env.MAX_NOTE_LENGTH, DEFAULT_MAX_NOTE_LENGTH, 1, 200, 'MAX_NOTE_LENGTH'),
    tokenDays: integerInRange(
      env.TOKEN_DAYS, DEFAULT_TOKEN_DAYS, MIN_TOKEN_DAYS, MAX_TOKEN_DAYS, 'TOKEN_DAYS (entre 30 y 60 días)',
    ),
    trustedProxyCidrs: (env.TRUSTED_PROXY_CIDRS
      || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
}
