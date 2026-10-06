// Seguimiento centrado del punto azul.
//
// Mientras se navega, cada fix recentra la cámara para que el punto quede en el
// centro exacto del viewport. El seguimiento se pausa solo cuando el usuario toca el
// mapa, y se retoma solo a los FOLLOW_RESUME_MS de la última interacción: mientras
// está pausado el punto se sigue actualizando, pero la cámara no se mueve.
//
// Es una máquina de estados pura sobre un temporizador inyectable, para poder probar
// los tiempos con fake timers sin mapa ni DOM.

export const FOLLOW_RESUME_MS = 8000;

export const createFollowState = ({
  resumeMs = FOLLOW_RESUME_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onResume = () => {},
} = {}) => {
  let following = true;
  let timer = null;

  const cancel = () => {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    isFollowing: () => following,

    // Interacción del usuario: se pausa y se reinicia la cuenta atrás. Cada
    // interacción nueva la vuelve a empezar, así el recentrado no llega mientras el
    // usuario sigue moviendo el mapa.
    interact: () => {
      following = false;
      cancel();
      timer = setTimer(() => {
        timer = null;
        following = true;
        onResume();
      }, resumeMs);
    },

    // Arranque de la navegación: se sigue desde el primer fix, sin esperar.
    start: () => {
      cancel();
      following = true;
    },

    // Fin de la navegación: no sigue y no queda nada pendiente de reanudar.
    stop: () => {
      cancel();
      following = false;
    },
  };
};
