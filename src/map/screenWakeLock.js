// Pantalla encendida durante la navegación con GPS.
//
// Dos motivos independientes mantienen la pantalla encendida: estar navegando
// (watch de ubicación activo) o que el teléfono esté cargando. Se suman con un OR,
// así desconectar el cargador mientras se navega no apaga la pantalla. En los dos
// casos hace falta que la app esté en primer plano: en segundo plano no hay nada que
// mirar y el navegador libera el lock igual.
//
// Se resuelve con la Screen Wake Lock API del propio WebView, verificada en el Galaxy
// A30 (Android 11, Chromium 153): navigator.wakeLock adquiere y libera el lock de
// 'screen' sin error. No hizo falta el plugin @capacitor-community/keep-awake ni
// FLAG_KEEP_SCREEN_ON desde nativo.
//
// La API exige contexto seguro: la app cumple porque Capacitor sirve desde
// https://localhost (server.androidScheme = 'https').

// Cada cuánto se relee el estado de carga como red de seguridad. getBattery()
// devuelve siempre el mismo BatteryManager, así que releerlo es barato; el evento
// 'chargingchange' es la vía normal y esto solo cubre que no llegue a dispararse.
export const CHARGING_POLL_MS = 20_000;

// Condición única que decide si corresponde mantener la pantalla encendida. Es pura
// para poder cubrir las ocho combinaciones sin WebView ni batería real.
export const shouldKeepScreenOn = ({ navigating, charging, foreground }) =>
  Boolean(foreground) && Boolean(navigating || charging);

// Controlador del lock. Las dependencias se inyectan para poder probarlo con dobles
// (no hay wakeLock ni document en el entorno de tests, que corre en node).
export const createScreenWakeLock = (deps = {}) => {
  const wakeLock = deps.wakeLock ?? globalThis.navigator?.wakeLock ?? null;
  // getBattery es un método del objeto navigator: hay que llamarlo con navigator como
  // receptor. Guardado como referencia suelta lanza "Illegal invocation" (verificado en
  // el WebView del A30 y en Chromium de escritorio) y el estado de carga quedaría
  // siempre en false, sin mantener la pantalla encendida al cargar. Se ata acá una vez.
  const getBattery =
    deps.getBattery ??
    (globalThis.navigator?.getBattery
      ? globalThis.navigator.getBattery.bind(globalThis.navigator)
      : null);
  const doc = deps.doc ?? globalThis.document;
  const intervalMs = deps.intervalMs ?? CHARGING_POLL_MS;
  const onError = deps.onError ?? (() => {});

  let navigating = false;
  let charging = false;
  let battery = null;
  let sentinel = null;
  let requesting = false;
  let pollTimer = null;
  let started = false;

  const isForeground = () => !doc.hidden;

  const wanted = () => shouldKeepScreenOn({ navigating, charging, foreground: isForeground() });

  const release = () => {
    const current = sentinel;
    // Se limpia la referencia antes de esperar: así un pedido nuevo que llegue
    // durante el await no se descarta por un lock que ya está de salida.
    sentinel = null;
    if (!current) return;
    Promise.resolve(current.release()).catch(onError);
  };

  const acquire = async () => {
    // Sin lock pedido, o con uno ya en mano o en camino, no se pide otro: es lo que
    // evita los locks duplicados cuando varios cambios de estado caen juntos.
    if (sentinel || requesting || !wakeLock?.request) return;
    requesting = true;
    try {
      const next = await wakeLock.request('screen');
      if (!wanted()) {
        // La condición cambió mientras se pedía (segundo plano, fin de la
        // navegación): liberar en el acto en vez de dejar la pantalla encendida
        // hasta el próximo cambio.
        await next.release();
        return;
      }
      sentinel = next;
      // El navegador puede liberar el lock por su cuenta (al ocultarse la página,
      // por ejemplo). Sin soltar la referencia quedaría un lock muerto en mano y
      // nunca se volvería a pedir.
      next.addEventListener?.('release', () => {
        if (sentinel === next) sentinel = null;
      });
    } catch (err) {
      // NotAllowedError es esperable: la página no está visible o no tiene foco.
      // No se propaga porque no debe interrumpir la navegación; el próximo cambio
      // de visibilidad vuelve a intentar.
      onError(err);
    } finally {
      requesting = false;
    }
  };

  const apply = () => {
    if (wanted()) acquire();
    else release();
  };

  // Única vía de lectura del estado de carga: se usa al arrancar, al volver a primer
  // plano, cuando el sistema avisa del cambio y en cada vuelta del sondeo.
  const refreshCharging = async () => {
    if (getBattery) {
      try {
        battery = battery ?? (await getBattery());
        charging = Boolean(battery.charging);
      } catch (err) {
        onError(err);
      }
    }
    apply();
  };

  const onVisibilityChange = () => {
    if (doc.hidden) {
      // En segundo plano no se mantiene la pantalla encendida y el navegador
      // libera el lock igual; liberarlo acá deja el estado consistente.
      release();
    } else {
      // Al volver hay que re-adquirir: el lock anterior ya no vale.
      refreshCharging();
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    doc.addEventListener?.('visibilitychange', onVisibilityChange);
    refreshCharging().then(() => {
      // El evento solo se engancha si getBattery respondió: sin BatteryManager no
      // hay a qué suscribirse. Si el WebView no lo expone, queda el sondeo.
      battery?.addEventListener?.('chargingchange', refreshCharging);
    });
    pollTimer = setInterval(() => {
      if (isForeground()) refreshCharging();
    }, intervalMs);
    apply();
  };

  const stop = () => {
    if (!started) return;
    started = false;
    doc.removeEventListener?.('visibilitychange', onVisibilityChange);
    battery?.removeEventListener?.('chargingchange', refreshCharging);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    navigating = false;
    charging = false;
    battery = null;
    release();
  };

  // La navegación es la única entrada que cambia desde la app; la carga y el primer
  // plano los observa el propio controlador.
  const setNavigating = (value) => {
    const next = Boolean(value);
    if (next === navigating) return;
    navigating = next;
    apply();
  };

  return {
    start,
    stop,
    setNavigating,
    // Para diagnóstico y tests: si el lock está efectivamente en mano.
    isHeld: () => sentinel != null,
  };
};
