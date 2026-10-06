import { describe, expect, it } from 'vitest';
import {
  DEAD_ZONE_DEG,
  MIN_SPEED_MPS,
  SMOOTHING,
  isUsableHeading,
  nextHeading,
  shortestDelta,
  stepHeading,
  wrap360,
} from './heading';

describe('shortestDelta', () => {
  it('mide el giro por el camino corto, no por el largo', () => {
    // De 359° a 1° son 2° hacia adelante, no 358° para atrás.
    expect(shortestDelta(1 - 359)).toBe(2);
    expect(shortestDelta(359 - 1)).toBe(-2);
  });

  it('nunca devuelve más de media vuelta', () => {
    for (let deg = -720; deg <= 720; deg += 7) {
      expect(Math.abs(shortestDelta(deg))).toBeLessThanOrEqual(180);
    }
  });

  it('trata el giro de 180° como positivo, sin importar el signo de entrada', () => {
    expect(shortestDelta(180)).toBe(180);
    expect(shortestDelta(-180)).toBe(180);
  });

  it('deja intactas las diferencias chicas', () => {
    expect(shortestDelta(0)).toBe(0);
    expect(shortestDelta(30)).toBe(30);
    expect(shortestDelta(-30)).toBe(-30);
  });
});

describe('wrap360', () => {
  it('normaliza a [0, 360)', () => {
    expect(wrap360(0)).toBe(0);
    expect(wrap360(359)).toBe(359);
    expect(wrap360(360)).toBe(0);
    expect(wrap360(370)).toBe(10);
    expect(wrap360(-10)).toBe(350);
    expect(wrap360(-370)).toBe(350);
  });
});

describe('isUsableHeading', () => {
  it('acepta un rumbo con velocidad suficiente', () => {
    expect(isUsableHeading(120, MIN_SPEED_MPS)).toBe(true);
    expect(isUsableHeading(0, 20)).toBe(true);
    expect(isUsableHeading(359.9, 5.5)).toBe(true);
  });

  it('rechaza el rumbo si falta o no es un número', () => {
    expect(isUsableHeading(null, 10)).toBe(false);
    expect(isUsableHeading(undefined, 10)).toBe(false);
    expect(isUsableHeading(NaN, 10)).toBe(false);
    expect(isUsableHeading('90', 10)).toBe(false);
    expect(isUsableHeading(Infinity, 10)).toBe(false);
  });

  it('rechaza la muestra si no hay velocidad o es baja (parado o a pie)', () => {
    expect(isUsableHeading(90, null)).toBe(false);
    expect(isUsableHeading(90, undefined)).toBe(false);
    expect(isUsableHeading(90, NaN)).toBe(false);
    expect(isUsableHeading(90, 0)).toBe(false);
    expect(isUsableHeading(90, MIN_SPEED_MPS - 0.01)).toBe(false);
  });
});

describe('stepHeading', () => {
  it('no mueve el rumbo dentro de la zona muerta', () => {
    expect(stepHeading(100, 100)).toBe(100);
    expect(stepHeading(100, 100 + DEAD_ZONE_DEG)).toBe(100);
    expect(stepHeading(100, 100 - DEAD_ZONE_DEG)).toBe(100);
  });

  it('avanza una fracción del cambio fuera de la zona muerta', () => {
    expect(stepHeading(100, 110)).toBeCloseTo(100 + 10 * SMOOTHING, 6);
  });

  it('gira por el camino corto al cruzar el norte', () => {
    // De 350° a 10°: el mapa debe pasar por 356°, no por 200°.
    const next = stepHeading(350, 10);
    expect(next).toBeCloseTo(356, 6);
    expect(next).toBeLessThanOrEqual(360);
  });

  it('se acerca al objetivo sin pasarse y se detiene dentro de la zona muerta', () => {
    let rumbo = 0;
    for (let i = 0; i < 40; i += 1) {
      rumbo = stepHeading(rumbo, 90);
      expect(rumbo).toBeLessThanOrEqual(90);
    }
    // Nunca llega a 90 exactos: al entrar en la zona muerta deja de moverse.
    expect(Math.abs(90 - rumbo)).toBeLessThanOrEqual(DEAD_ZONE_DEG);
    const anterior = rumbo;
    expect(stepHeading(anterior, 90)).toBe(anterior);
  });

  it('con alfa 1 se pega al objetivo', () => {
    expect(stepHeading(0, 90, { alpha: 1 })).toBe(90);
  });

  it('siempre devuelve un rumbo normalizado', () => {
    expect(wrap360(stepHeading(350, 20))).toBe(stepHeading(350, 20));
    // Salto de 20° cruzando el norte: el resultado vuelve al rango [0, 360).
    expect(stepHeading(350, 10, { alpha: 1 })).toBe(10);
    expect(stepHeading(355, 5, { alpha: 1 })).toBe(5);
  });
});

describe('nextHeading', () => {
  it('sin muestra previa adopta el primer rumbo creíble', () => {
    expect(nextHeading({ previous: null, heading: 42, speed: 10 })).toBe(42);
    expect(nextHeading({ previous: null, heading: -10, speed: 10 })).toBe(350);
  });

  it('sin muestra previa y sin velocidad creíble devuelve null', () => {
    expect(nextHeading({ previous: null, heading: 42, speed: 0 })).toBe(null);
    expect(nextHeading({ previous: null, heading: null, speed: 10 })).toBe(null);
  });

  it('conserva el último rumbo bueno cuando la muestra no sirve', () => {
    // Frenando en un semáforo: el rumbo del GPS se vuelve ruido y no debe mover el mapa.
    expect(nextHeading({ previous: 200, heading: 15, speed: 0.3 })).toBe(200);
    expect(nextHeading({ previous: 200, heading: null, speed: 12 })).toBe(200);
  });

  it('suaviza cuando la muestra sirve', () => {
    expect(nextHeading({ previous: 100, heading: 110, speed: 12 })).toBeCloseTo(
      100 + 10 * SMOOTHING,
      6,
    );
  });

  it('respeta parámetros propios de zona muerta y suavizado', () => {
    expect(nextHeading({ previous: 100, heading: 103, speed: 12, deadZone: 5 })).toBe(100);
    expect(nextHeading({ previous: 100, heading: 120, speed: 12, alpha: 1 })).toBe(120);
  });

  it('no gira de más en una racha de muestras ruidosas', () => {
    // Rumbo oscilando ±30° alrededor de 90: el mapa debe quedarse cerca de 90 en vez de
    // barrer los 60° de la oscilación.
    const muestras = [60, 120, 60, 120, 60, 120];
    let rumbo = 90;
    muestras.forEach((heading) => {
      const siguiente = nextHeading({ previous: rumbo, heading, speed: 15 });
      // Cada paso mueve menos que el salto crudo del rumbo.
      expect(Math.abs(shortestDelta(siguiente - rumbo))).toBeLessThan(
        Math.abs(shortestDelta(heading - rumbo)),
      );
      rumbo = siguiente;
    });
    expect(Math.abs(shortestDelta(rumbo - 90))).toBeLessThan(15);
  });
});
