import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScreenWakeLock, shouldKeepScreenOn } from './screenWakeLock';

// Deja correr la cadena de promesas del controlador (getBattery → apply → request)
// sin depender de tiempos reales.
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const createFakeWakeLock = () => {
  const requests = [];
  return {
    requests,
    request: async () => {
      const sentinel = {
        released: false,
        listeners: {},
        release: async () => {
          sentinel.released = true;
        },
        addEventListener: (type, fn) => {
          sentinel.listeners[type] = fn;
        },
      };
      requests.push(sentinel);
      return sentinel;
    },
  };
};

const createFakeDoc = (hidden = false) => {
  const listeners = new Map();
  return {
    hidden,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type) => listeners.get(type)?.(),
  };
};

const createFakeBattery = (charging) => {
  const listeners = new Map();
  const manager = {
    charging,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type) => listeners.get(type)?.(),
  };
  return manager;
};

const setup = async ({ charging = false, hidden = false, wakeLock } = {}) => {
  const doc = createFakeDoc(hidden);
  const battery = createFakeBattery(charging);
  const lock = wakeLock ?? createFakeWakeLock();
  const onError = vi.fn();
  const controller = createScreenWakeLock({
    wakeLock: lock,
    getBattery: async () => battery,
    doc,
    onError,
  });
  controller.start();
  await flush();
  return { controller, doc, battery, lock, onError };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shouldKeepScreenOn', () => {
  // Las ocho combinaciones: la pantalla se mantiene encendida navegando o cargando,
  // pero nunca con la app en segundo plano.
  const CASOS = [
    { navigating: false, charging: false, foreground: false, esperado: false },
    { navigating: false, charging: false, foreground: true, esperado: false },
    { navigating: false, charging: true, foreground: false, esperado: false },
    { navigating: false, charging: true, foreground: true, esperado: true },
    { navigating: true, charging: false, foreground: false, esperado: false },
    { navigating: true, charging: false, foreground: true, esperado: true },
    { navigating: true, charging: true, foreground: false, esperado: false },
    { navigating: true, charging: true, foreground: true, esperado: true },
  ];

  CASOS.forEach(({ navigating, charging, foreground, esperado }) => {
    it(`navegando=${navigating} cargando=${charging} primerPlano=${foreground} → ${esperado}`, () => {
      expect(shouldKeepScreenOn({ navigating, charging, foreground })).toBe(esperado);
    });
  });
});

describe('createScreenWakeLock', () => {
  it('no pide el lock si no se navega ni se está cargando', async () => {
    const { lock, controller } = await setup();

    expect(lock.requests).toHaveLength(0);
    expect(controller.isHeld()).toBe(false);
  });

  it('enciende la pantalla al empezar a navegar y la apaga al detener', async () => {
    const { lock, controller } = await setup();

    controller.setNavigating(true);
    await flush();
    expect(lock.requests).toHaveLength(1);
    expect(controller.isHeld()).toBe(true);

    controller.setNavigating(false);
    await flush();
    expect(lock.requests[0].released).toBe(true);
    expect(controller.isHeld()).toBe(false);
  });

  it('no pide un lock duplicado si ya tiene uno en mano', async () => {
    const { lock, controller, battery } = await setup();

    controller.setNavigating(true);
    await flush();
    // Cambios de estado que vuelven a evaluar la condición con el lock ya tomado.
    controller.setNavigating(true);
    battery.fire('chargingchange');
    await flush();

    expect(lock.requests).toHaveLength(1);
  });

  it('mantiene la pantalla encendida si se desconecta el cargador mientras navega', async () => {
    const { lock, controller, battery } = await setup({ charging: true });
    controller.setNavigating(true);
    await flush();

    battery.charging = false;
    battery.fire('chargingchange');
    await flush();

    expect(controller.isHeld()).toBe(true);
    // Sin soltar y volver a pedir: sería un parpadeo de la pantalla.
    expect(lock.requests).toHaveLength(1);
    expect(lock.requests[0].released).toBe(false);
  });

  it('mantiene la pantalla encendida con el teléfono cargando aunque no se navegue', async () => {
    const { controller } = await setup({ charging: true });

    expect(controller.isHeld()).toBe(true);
  });

  // navigator.getBattery es un método del objeto navigator: si se guarda como
  // referencia suelta y se lo llama sin receptor, Chromium responde "Illegal
  // invocation" y el estado de carga queda en false para siempre (la pantalla no se
  // mantendría encendida al cargar). El doble imita esa exigencia de receptor y por
  // eso se inyecta en globalThis en vez de pasarlo por deps.getBattery.
  it('lee la carga cuando getBattery exige a navigator como receptor', async () => {
    const lock = createFakeWakeLock();
    const battery = createFakeBattery(true);
    const nav = {
      getBattery() {
        if (this !== nav) {
          throw new TypeError("Failed to execute 'getBattery' on 'Navigator': Illegal invocation");
        }
        return Promise.resolve(battery);
      },
    };
    vi.stubGlobal('navigator', nav);
    const onError = vi.fn();
    const controller = createScreenWakeLock({ wakeLock: lock, doc: createFakeDoc(), onError });
    controller.start();
    await flush();

    expect(onError).not.toHaveBeenCalled();
    expect(lock.requests).toHaveLength(1);
  });

  it('sigue con el lock en mano si se detiene la navegación pero el teléfono carga', async () => {
    const { lock, controller } = await setup({ charging: true });
    controller.setNavigating(true);
    await flush();

    controller.setNavigating(false);
    await flush();

    expect(controller.isHeld()).toBe(true);
    expect(lock.requests[0].released).toBe(false);
  });

  it('libera el lock en segundo plano y lo vuelve a pedir al volver', async () => {
    const { lock, controller, doc } = await setup();
    controller.setNavigating(true);
    await flush();
    expect(lock.requests).toHaveLength(1);

    doc.hidden = true;
    doc.fire('visibilitychange');
    await flush();
    expect(controller.isHeld()).toBe(false);
    expect(lock.requests[0].released).toBe(true);

    doc.hidden = false;
    doc.fire('visibilitychange');
    await flush();
    expect(lock.requests).toHaveLength(2);
    expect(controller.isHeld()).toBe(true);
  });

  it('no pide el lock si vuelve a primer plano sin motivo para tenerlo', async () => {
    const { lock, controller, doc } = await setup();
    controller.setNavigating(true);
    await flush();

    doc.hidden = true;
    doc.fire('visibilitychange');
    await flush();

    controller.setNavigating(false);
    doc.hidden = false;
    doc.fire('visibilitychange');
    await flush();

    expect(lock.requests).toHaveLength(1);
    expect(controller.isHeld()).toBe(false);
  });

  it('reintenta al volver a primer plano si el navegador rechazó el lock', async () => {
    const wakeLock = createFakeWakeLock();
    let rechazar = true;
    const original = wakeLock.request;
    wakeLock.request = async () => {
      if (rechazar) {
        const err = new Error('no visible');
        err.name = 'NotAllowedError';
        throw err;
      }
      return original();
    };
    const { controller, doc, onError, lock } = await setup({ wakeLock });
    controller.setNavigating(true);
    await flush();

    // El rechazo queda reportado pero no deja el controlador roto.
    expect(onError).toHaveBeenCalled();
    expect(controller.isHeld()).toBe(false);

    rechazar = false;
    doc.fire('visibilitychange');
    await flush();

    expect(lock.requests).toHaveLength(1);
    expect(controller.isHeld()).toBe(true);
  });

  it('stop libera el lock y deja de observar la visibilidad', async () => {
    const { lock, controller, doc } = await setup({ charging: true });
    controller.setNavigating(true);
    await flush();

    controller.stop();
    await flush();

    expect(lock.requests[0].released).toBe(true);
    expect(controller.isHeld()).toBe(false);

    // Ya no reacciona a la visibilidad: no vuelve a pedir el lock.
    doc.hidden = false;
    doc.fire('visibilitychange');
    await flush();
    expect(lock.requests).toHaveLength(1);
  });
});
