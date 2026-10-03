import { describe, it, expect } from 'vitest';
import { tileToBbox } from './tileMath';

describe('tileToBbox', () => {
  it('cubre el mundo entero en el tile (0,0,0)', () => {
    const [west, south, east, north] = tileToBbox(0, 0, 0);
    expect(west).toBe(-180);
    expect(east).toBe(180);
    expect(north).toBeCloseTo(85.05112878, 5);
    expect(south).toBeCloseTo(-85.05112878, 5);
  });

  it('devuelve el cuadrante noroeste en el tile (1,0,0)', () => {
    const [west, south, east, north] = tileToBbox(1, 0, 0);
    expect(west).toBe(-180);
    expect(east).toBe(0);
    expect(north).toBeCloseTo(85.05112878, 5);
    expect(south).toBeCloseTo(0, 5);
  });

  it('devuelve [oeste, sur, este, norte] con oeste<este y sur<norte', () => {
    const bbox = tileToBbox(10, 300, 400);
    expect(bbox[0]).toBeLessThan(bbox[2]);
    expect(bbox[1]).toBeLessThan(bbox[3]);
  });
});
