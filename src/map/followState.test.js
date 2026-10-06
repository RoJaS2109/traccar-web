import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFollowState, FOLLOW_RESUME_MS } from './followState';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createFollowState', () => {
  it('arranca siguiendo', () => {
    const follow = createFollowState();

    expect(follow.isFollowing()).toBe(true);
  });

  it('deja de seguir apenas el usuario toca el mapa', () => {
    const follow = createFollowState();

    follow.interact();

    expect(follow.isFollowing()).toBe(false);
  });

  it('retoma solo a los 8 s de la última interacción', () => {
    const onResume = vi.fn();
    const follow = createFollowState({ onResume });

    follow.interact();
    vi.advanceTimersByTime(FOLLOW_RESUME_MS - 1);
    expect(follow.isFollowing()).toBe(false);
    expect(onResume).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(follow.isFollowing()).toBe(true);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('reinicia la cuenta atrás con cada interacción nueva', () => {
    const onResume = vi.fn();
    const follow = createFollowState({ onResume });

    follow.interact();
    vi.advanceTimersByTime(5000);
    follow.interact();
    vi.advanceTimersByTime(5000);

    // Diez segundos desde la primera, pero solo cinco desde la última.
    expect(follow.isFollowing()).toBe(false);
    expect(onResume).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(follow.isFollowing()).toBe(true);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('no retoma si se detuvo la navegación mientras estaba pausado', () => {
    const onResume = vi.fn();
    const follow = createFollowState({ onResume });

    follow.interact();
    follow.stop();
    vi.advanceTimersByTime(FOLLOW_RESUME_MS * 2);

    expect(follow.isFollowing()).toBe(false);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('vuelve a seguir al arrancar y descarta una reanudación pendiente', () => {
    const onResume = vi.fn();
    const follow = createFollowState({ onResume });

    follow.interact();
    follow.start();

    expect(follow.isFollowing()).toBe(true);

    // El temporizador de la interacción anterior ya no existe: no avisa de más.
    vi.advanceTimersByTime(FOLLOW_RESUME_MS * 2);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('avisa una sola vez por reanudación', () => {
    const onResume = vi.fn();
    const follow = createFollowState({ onResume });

    follow.interact();
    vi.advanceTimersByTime(FOLLOW_RESUME_MS);
    vi.advanceTimersByTime(FOLLOW_RESUME_MS * 3);

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('respeta un tiempo de reanudación distinto', () => {
    const follow = createFollowState({ resumeMs: 1500 });

    follow.interact();
    vi.advanceTimersByTime(1499);
    expect(follow.isFollowing()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(follow.isFollowing()).toBe(true);
  });
});
