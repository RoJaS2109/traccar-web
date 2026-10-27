// Lista de KML de POIs disponibles en el selector del mapa.
//
// Se configura en el atributo `poiLayers` del servidor (o del usuario), una línea por
// KML con el formato `Nombre|ruta`. Sin nombre, se usa el del archivo. Si el atributo no
// está, se usa la preferencia `poiLayer` de siempre (un único KML), que además es la que
// leen las APK anteriores al selector.

const fileName = (url) => {
  const last = url.split('?')[0].split('/').pop() || url;
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // Nombre con un % suelto: se muestra tal cual.
  }
  return name.replace(/\.kml$/i, '');
};

// Rutas con espacios u otros caracteres (como el KML de mascotas) se codifican una sola
// vez: lo que ya viene codificado no se vuelve a codificar.
const encodeUrl = (url) => {
  try {
    return encodeURI(decodeURI(url));
  } catch {
    return encodeURI(url);
  }
};

export const parsePoiLayers = (poiLayers, poiLayer) => {
  const layers = [];
  (poiLayers || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const separator = trimmed.indexOf('|');
    const name = separator >= 0 ? trimmed.slice(0, separator).trim() : '';
    const path = (separator >= 0 ? trimmed.slice(separator + 1) : trimmed).trim();
    if (!path) return;
    const url = encodeUrl(path);
    if (layers.some((layer) => layer.url === url)) return;
    layers.push({ name: name || fileName(path), url });
  });
  if (layers.length === 0 && poiLayer) {
    layers.push({ name: fileName(poiLayer), url: encodeUrl(poiLayer) });
  }
  return layers;
};
