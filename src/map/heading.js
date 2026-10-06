// Rumbo del mapa (norte arriba / rumbo arriba).
//
// El rumbo que entrega el plugin de geolocalización es ruidoso: parado o a baja
// velocidad apunta a cualquier lado, porque el receptor lo calcula del desplazamiento
// entre fixes. Por eso acá se decide cuándo creerle (velocidad suficiente), se corrige
// por el camino más corto (359° → 1° son 2°, no 358°) y se suaviza para que el mapa no
// gire a los saltos.
//
// Son funciones puras, sin mapa ni DOM, para poder probarlas con valores conocidos.

// Velocidad mínima para creerle al rumbo: 1,5 m/s ≈ 5,4 km/h. Por debajo de eso el
// desplazamiento entre fixes es tan chico que el rumbo es ruido.
export const MIN_SPEED_MPS = 1.5;

// Zona muerta: una diferencia de hasta 4° no mueve el mapa. Evita el temblor cuando el
// rumbo oscila alrededor del valor real yendo en línea recta.
export const DEAD_ZONE_DEG = 4;

// Factor del suavizado exponencial por muestra: con 0,3 el mapa recorre el 95% del
// cambio en unas 9 muestras (≈18 s con un fix cada 2 s), que es un giro visible pero no
// brusco.
export const SMOOTHING = 0.3;

// Diferencia más corta entre dos rumbos, normalizada a (-180, 180].
export const shortestDelta = (deg) => {
  const delta = ((((deg + 180) % 360) + 360) % 360) - 180;
  // El -180 y el 180 son el mismo giro: se devuelve siempre positivo para que el signo
  // no dependa de por dónde entró el valor.
  return delta === -180 ? 180 : delta;
};

// Normaliza un rumbo a [0, 360).
export const wrap360 = (deg) => ((deg % 360) + 360) % 360;

// Un rumbo sirve si es un número finito y hay velocidad suficiente. Sin dato de
// velocidad no se puede descartar que el vehículo esté parado, así que tampoco sirve.
export const isUsableHeading = (heading, speed, minSpeed = MIN_SPEED_MPS) =>
  Number.isFinite(heading) && Number.isFinite(speed) && speed >= minSpeed;

// Acerca el rumbo actual al objetivo sin pasar por el camino largo, respetando la zona
// muerta. `previous` ya viene normalizado.
export const stepHeading = (
  previous,
  target,
  { deadZone = DEAD_ZONE_DEG, alpha = SMOOTHING } = {},
) => {
  const delta = shortestDelta(target - previous);
  if (Math.abs(delta) <= deadZone) return wrap360(previous);
  return wrap360(previous + delta * alpha);
};

// Rumbo a usar con el fix nuevo. Devuelve `previous` cuando la muestra no sirve (sin
// rumbo, sin velocidad o a paso de persona), para conservar el último rumbo bueno en vez
// de volver a norte o saltar a un valor espurio.
export const nextHeading = ({
  previous = null,
  heading,
  speed,
  deadZone = DEAD_ZONE_DEG,
  alpha = SMOOTHING,
  minSpeed = MIN_SPEED_MPS,
} = {}) => {
  if (!isUsableHeading(heading, speed, minSpeed)) return previous;
  // Primera muestra creíble: se adopta tal cual, no hay nada de dónde suavizar.
  if (previous == null) return wrap360(heading);
  return stepHeading(previous, heading, { deadZone, alpha });
};
