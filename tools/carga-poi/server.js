const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Ruta del KML (configurable por variable de entorno)
const KML_PATH = process.env.KML_PATH || '/data/kml/general.kml';

// Validar que la ruta sea un archivo, no un directorio
function verificarKML() {
  if (!fs.existsSync(KML_PATH)) {
    throw new Error(`KML no encontrado: ${KML_PATH}`);
  }
  if (fs.statSync(KML_PATH).isDirectory()) {
    throw new Error(
      `${KML_PATH} es un directorio, no un archivo. ` +
      `Verificá que el volumen de Docker esté montado correctamente.\n` +
      `Ejemplo: docker run -v /ruta/real/general.kml:/data/kml/general.kml ...`
    );
  }
}

/**
 * Calcula la distancia en metros entre dos puntos geográficos.
 * Usa la fórmula de Haversine.
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Radio de la Tierra en metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Parsea todos los Placemarks del KML y devuelve sus datos estructurados.
 * Extrae nombre, coordenadas, categoría, y la última entrada del log.
 */
function parsearPOIs() {
  verificarKML();
  const kml = fs.readFileSync(KML_PATH, 'utf8');

  const pois = [];
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let match;

  while ((match = placemarkRegex.exec(kml)) !== null) {
    const block = match[1];

    // Extraer <name>
    const nameMatch = block.match(/<name>([^<]*)<\/name>/);
    if (!nameMatch) continue;
    const nombreCompleto = nameMatch[1].trim();

    // Extraer <description> completa
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    const descripcionCompleta = descMatch ? descMatch[1].trim() : '';

    // Extraer <styleUrl>
    const styleMatch = block.match(/<styleUrl>([^<]*)<\/styleUrl>/);
    const styleUrl = styleMatch ? styleMatch[1].trim() : '';

    // Extraer <coordinates>lon,lat,0</coordinates>
    const coordMatch = block.match(/<coordinates>\s*([\d.\-]+),([\d.\-]+)/);
    if (!coordMatch) continue;
    const lon = parseFloat(coordMatch[1]);
    const lat = parseFloat(coordMatch[2]);

    // Parsear nombre para extraer nombre base y localidad
    // Formato: "Nombre[, Localidad] lat, lon" o "Nombre simple"
    const coordInNameRegex = /(-?\d+\.?\d*),\s*(-?\d+\.?\d*)\s*$/;
    const coordInName = nombreCompleto.match(coordInNameRegex);
    let nombre, localidad;
    if (coordInName) {
      const namePart = nombreCompleto.slice(0, coordInName.index).trim();
      const commaIdx = namePart.indexOf(',');
      if (commaIdx !== -1) {
        nombre = namePart.slice(0, commaIdx).trim();
        localidad = namePart.slice(commaIdx + 1).trim();
      } else {
        nombre = namePart;
        localidad = '';
      }
    } else {
      nombre = nombreCompleto;
      localidad = '';
    }

    // Mapear styleUrl a categoria ID
    const catEntry = Object.entries(CATEGORIAS).find(
      ([, info]) => info.styleUrl === styleUrl
    );
    const categoriaId = catEntry ? catEntry[0] : '';

    // Limpiar la descripción para mostrarla completa en el textarea
    const ultimoComentario = descripcionCompleta
      .replace(/&lt;br\s*\/?&gt;/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .split('\n')
      .map(l => l.trim())
      .join('\n')
      .trim();

    pois.push({
      nombreCompleto,
      lat,
      lon,
      styleUrl,
      descripcionCompleta,
      nombre,
      localidad,
      categoriaId,
      ultimoComentario
    });
  }

  return pois;
}

/**
 * Crea un backup del KML antes de cada escritura.
 * Retiene los últimos 30 backups, borrando los más viejos.
 */
function backupKML() {
  const now = new Date();
  const ts = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const bakPath = `${KML_PATH}.bak-${ts}`;

  fs.copyFileSync(KML_PATH, bakPath);
  console.log(`Backup creado: ${bakPath}`);

  // Limpiar backups viejos (retener últimos 30)
  const dir = path.dirname(KML_PATH);
  const base = path.basename(KML_PATH);
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(base + '.bak-'))
    .map(f => ({ name: f, path: path.join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name)); // orden cronológico por timestamp

  while (files.length > 30) {
    const viejo = files.shift();
    fs.unlinkSync(viejo.path);
    console.log(`Backup eliminado (límite 30): ${viejo.path}`);
  }
}

// Categorías → styleUrl e ícono
const CATEGORIAS = {
  'acampe_libre': {
    label: 'Acampe libre / Pernocte libre',
    styleUrl: '#icon-1859-558B2F',
    icon: 'acampe_libre.png'
  },
  'acampe_pago': {
    label: 'Camping de pago',
    styleUrl: '#icon-1859-FFD600',
    icon: 'acampe_pago.png'
  },
  'agua': {
    label: 'Toma de agua gratis',
    styleUrl: '#icon-1703-64B5F6',
    icon: 'agua.png'
  },
  'aguas_negras': {
    label: 'Descarga de aguas negras',
    styleUrl: '#icon-1781-A52714',
    icon: 'aguas_negras.png'
  },
  'controles_azul': {
    label: 'Control Aduanero / Policial',
    styleUrl: '#icon-1657-B0B0B0',
    icon: 'controles_azul.png'
  },
  'fitosanitario': {
    label: 'Fitosanitario',
    styleUrl: '#icon-1657-D6336C',
    icon: 'controles_fitosanitario.png'
  },
  'gendarmeria': {
    label: 'Control de Gendarmería',
    styleUrl: '#icon-1657-5B6E3F',
    icon: 'controles_gendarmeria.png'
  },
  'duchas': {
    label: 'Duchas',
    styleUrl: '#icon-1865-64B5F6',
    icon: 'duchas.png'
  },
  'feriar_vender': {
    label: 'Feriar / Vender',
    styleUrl: '#icon-1737-E65100',
    icon: 'feriar_vender.png'
  },
  'garrafa': {
    label: 'Gas / Recarga de garrafa',
    styleUrl: '#icon-1899-DB4436',
    icon: 'garrafa.png'
  },
  'laverap': {
    label: 'Laverrap',
    styleUrl: '#icon-1821-B39DDB',
    icon: 'laverap.png'
  },
  'tomacorrientes': {
    label: 'Tomacorriente gratis',
    styleUrl: '#icon-1608-F9A825',
    icon: 'tomacorrientes_gratis.png'
  },
  'uso_diurno': {
    label: 'Solo uso diurno',
    styleUrl: '#icon-1650-9ACD32',
    icon: 'uso_diurno.png'
  },
  'wifi': {
    label: 'WiFi',
    styleUrl: '#icon-1507-0288D1',
    icon: 'wifi.png'
  },
  'varios': {
    label: 'Misceláneos / Varios',
    styleUrl: '#icon-1859-BDBDBD',
    icon: 'varios.png'
  }
};

// GET /api/categorias — lista de categorías disponibles
app.get('/api/categorias', (req, res) => {
  const cats = Object.entries(CATEGORIAS).map(([id, info]) => ({
    id,
    label: info.label,
    icon: `https://rudatrak.com/icons/${info.icon}`
  }));
  res.json(cats);
});

// POST /api/poi — agregar un nuevo POI
app.post('/api/poi', (req, res) => {
  const { nombre, localidad, coordenadas, categoria, autor, comentario } = req.body;

  // Validar campos obligatorios
  const errores = [];
  if (!nombre || !nombre.trim()) errores.push('Nombre es obligatorio');
  if (!autor || !autor.trim()) errores.push('Autor es obligatorio');
  if (!comentario || !comentario.trim()) errores.push('Comentario es obligatorio');
  if (!categoria || !CATEGORIAS[categoria]) errores.push('Categoría inválida');

  // Validar coordenadas en formato [-lat, -lon] o lat,lon
  let latNum, lonNum;
  const coordRaw = (coordenadas || '').trim().replace(/[\[\]()]/g, '');
  const parts = coordRaw.split(/[\s,]+/).filter(p => p !== '');
  if (parts.length >= 2) {
    latNum = parseFloat(parts[0]);
    lonNum = parseFloat(parts[1]);
  }
  if (isNaN(latNum) || latNum < -90 || latNum > 90) errores.push('Latitud inválida (debe ser entre -90 y 90)');
  if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) errores.push('Longitud inválida (debe ser entre -180 y 180)');

  const loc = (localidad || '').trim();

  if (errores.length > 0) {
    return res.status(400).json({ ok: false, errores });
  }

  try {
    // Leer KML actual
    verificarKML();

    let kml = fs.readFileSync(KML_PATH, 'utf8');

    // Generar nombre automático: "Nombre, Localidad -lat, lon" o "Nombre -lat, lon"
    const latStr = latNum.toFixed(6);
    const lonStr = lonNum.toFixed(6);
    const nombreCompleto = loc
      ? `${nombre.trim()}, ${loc} ${latStr}, ${lonStr}`
      : `${nombre.trim()} ${latStr}, ${lonStr}`;

    // Generar descripción con fecha actual
    const hoy = new Date();
    const meses = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const fecha = `${hoy.getDate()} de ${meses[hoy.getMonth()]} de ${hoy.getFullYear()}`;
    const descripcion = `&lt;br&gt;&lt;br&gt;${fecha} por ${autor.trim()}&lt;br&gt;${comentario.trim()}`;

    // Crear el nuevo Placemark
    const styleUrl = CATEGORIAS[categoria].styleUrl;
    const nuevoPlacemark = `      <Placemark>
        <name>${nombreCompleto}</name>
        <description>${descripcion}</description>
        <styleUrl>${styleUrl}</styleUrl>
<Point>
          <coordinates>
            ${lonStr},${latStr},0
          </coordinates>
        </Point>
      </Placemark>`;

    // Insertar dentro de la primera carpeta (Lugares para pernoctar), antes de su </Folder>
    const primeraCarpeta = kml.indexOf('<Folder>');
    const cierrePrimeraCarpeta = kml.indexOf('</Folder>', primeraCarpeta);

    if (primeraCarpeta === -1 || cierrePrimeraCarpeta === -1) {
      return res.status(500).json({ ok: false, error: 'Estructura KML inválida: no se encontró <Folder>' });
    }

    // Insertar antes del cierre de la primera carpeta
    kml = kml.slice(0, cierrePrimeraCarpeta) + '\n' + nuevoPlacemark + '\n    ' + kml.slice(cierrePrimeraCarpeta);

    // Backup + guardar
    backupKML();
    fs.writeFileSync(KML_PATH, kml, 'utf8');

    res.json({
      ok: true,
      poi: {
        nombre: nombreCompleto,
        lat: latStr,
        lon: lonStr,
        categoria: CATEGORIAS[categoria].label,
        icon: CATEGORIAS[categoria].icon
      }
    });

  } catch (err) {
    console.error('Error al guardar POI:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/poi/search?name=... — buscar un POI por nombre exacto
app.get('/api/poi/search', (req, res) => {
  const nombre = (req.query.name || '').trim();
  if (!nombre) {
    return res.status(400).json({ ok: false, error: 'Nombre es obligatorio' });
  }

  try {
    verificarKML();

    const kml = fs.readFileSync(KML_PATH, 'utf8');
    const nameTag = `<name>${nombre}</name>`;
    const nameIndex = kml.indexOf(nameTag);

    if (nameIndex === -1) {
      return res.status(404).json({
        ok: false,
        error: 'POI no encontrado. Verificá que el nombre sea exacto (incluyendo mayúsculas, tildes, coordenadas).'
      });
    }

    // Verificar que no haya duplicados
    const secondIndex = kml.indexOf(nameTag, nameIndex + 1);
    if (secondIndex !== -1) {
      return res.status(409).json({
        ok: false,
        error: 'Hay más de un punto con ese nombre exacto. Contactá al administrador para eliminarlo manualmente.'
      });
    }

    // Extraer el Placemark completo
    const placemarkStart = kml.lastIndexOf('<Placemark>', nameIndex);
    const placemarkEnd = kml.indexOf('</Placemark>', nameIndex) + '</Placemark>'.length;
    const placemark = kml.slice(placemarkStart, placemarkEnd);

    // Extraer campos
    const descMatch = placemark.match(/<description>([\s\S]*?)<\/description>/);
    const description = descMatch ? descMatch[1].trim() : '';

    const styleMatch = placemark.match(/<styleUrl>([^<]*)<\/styleUrl>/);
    const styleUrl = styleMatch ? styleMatch[1].trim() : '';

    const coordMatch = placemark.match(/<coordinates>\s*([\d.\-]+),([\d.\-]+)/);
    const lon = coordMatch ? coordMatch[1] : '';
    const lat = coordMatch ? coordMatch[2] : '';

    // Buscar categoría por styleUrl
    const catEntry = Object.entries(CATEGORIAS).find(([, info]) => info.styleUrl === styleUrl);
    const categoria = catEntry ? catEntry[1].label : (styleUrl || 'Desconocida');

    res.json({
      ok: true,
      poi: { nombre, descripcion: description, categoria, lat, lon }
    });

  } catch (err) {
    console.error('Error al buscar POI:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/poi/nearby?lat=X&lon=Y&radius=30 — buscar POIs por proximidad
app.get('/api/poi/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseFloat(req.query.radius) || 30;

  if (isNaN(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({ ok: false, error: 'Latitud inválida (debe ser entre -90 y 90)' });
  }
  if (isNaN(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ ok: false, error: 'Longitud inválida (debe ser entre -180 y 180)' });
  }
  if (isNaN(radius) || radius <= 0 || radius > 10000) {
    return res.status(400).json({ ok: false, error: 'Radio inválido (debe ser entre 1 y 10000 metros)' });
  }

  try {
    const todos = parsearPOIs();

    const cercanos = todos
      .map(poi => ({
        ...poi,
        distancia: haversine(lat, lon, poi.lat, poi.lon)
      }))
      .filter(poi => poi.distancia <= radius)
      .sort((a, b) => a.distancia - b.distancia);

    const pois = cercanos.map(p => ({
      nombreCompleto: p.nombreCompleto,
      nombre: p.nombre,
      localidad: p.localidad,
      lat: p.lat,
      lon: p.lon,
      distancia: Math.round(p.distancia * 10) / 10,
      categoriaId: p.categoriaId,
      categoriaLabel: CATEGORIAS[p.categoriaId]?.label || 'Desconocida',
      styleUrl: p.styleUrl,
      ultimoComentario: p.ultimoComentario,
      descripcionCompleta: p.descripcionCompleta
    }));

    res.json({
      ok: true,
      pois,
      masCercano: pois.length > 0 ? pois[0] : null
    });
  } catch (err) {
    console.error('Error en nearby:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/poi — actualizar un POI existente
app.put('/api/poi', (req, res) => {
  const { nombreActual, nombre, localidad, coordenadas, categoria, comentario } = req.body;

  // Validar campos obligatorios
  const errores = [];
  if (!nombreActual || !nombreActual.trim()) errores.push('Nombre actual es obligatorio (para identificar el POI)');
  if (!nombre || !nombre.trim()) errores.push('Nombre es obligatorio');
  if (!comentario || !comentario.trim()) errores.push('Comentario es obligatorio');
  if (!categoria || !CATEGORIAS[categoria]) errores.push('Categoría inválida');

  // Validar coordenadas
  let latNum, lonNum;
  const coordRaw = (coordenadas || '').trim().replace(/[\[\]()]/g, '');
  const parts = coordRaw.split(/[\s,]+/).filter(p => p !== '');
  if (parts.length >= 2) {
    latNum = parseFloat(parts[0]);
    lonNum = parseFloat(parts[1]);
  }
  if (isNaN(latNum) || latNum < -90 || latNum > 90) errores.push('Latitud inválida (debe ser entre -90 y 90)');
  if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) errores.push('Longitud inválida (debe ser entre -180 y 180)');

  const loc = (localidad || '').trim();

  if (errores.length > 0) {
    return res.status(400).json({ ok: false, errores });
  }

  try {
    verificarKML();
    let kml = fs.readFileSync(KML_PATH, 'utf8');

    // Buscar el Placemark por nombre exacto
    const nameTag = `<name>${nombreActual.trim()}</name>`;
    const nameIndex = kml.indexOf(nameTag);

    if (nameIndex === -1) {
      return res.status(404).json({
        ok: false,
        error: 'POI no encontrado con ese nombre exacto. Puede haber sido modificado mientras editabas.'
      });
    }

    // Verificar duplicados
    const secondIndex = kml.indexOf(nameTag, nameIndex + 1);
    if (secondIndex !== -1) {
      return res.status(409).json({
        ok: false,
        error: 'Hay más de un punto con ese nombre exacto. Contactá al administrador.'
      });
    }

    // Encontrar inicio y fin del Placemark
    const placemarkStart = kml.lastIndexOf('<Placemark>', nameIndex);
    const placemarkEnd = kml.indexOf('</Placemark>', nameIndex) + '</Placemark>'.length;

    if (placemarkStart === -1 || placemarkEnd === -1) {
      return res.status(500).json({ ok: false, error: 'Estructura KML inválida alrededor del Placemark' });
    }

    // Generar nuevo nombre completo
    const latStr = latNum.toFixed(6);
    const lonStr = lonNum.toFixed(6);
    const nuevoNombre = loc
      ? `${nombre.trim()}, ${loc} ${latStr}, ${lonStr}`
      : `${nombre.trim()} ${latStr}, ${lonStr}`;

    // La descripción se toma directamente del textarea (el usuario edita todo el historial).
    // Convertir saltos de línea a &lt;br&gt; para almacenar en KML.
    const nuevaDescripcion = comentario.trim()
      .split('\n')
      .map(l => l.trim())
      .join('&lt;br&gt;');

    // Extraer el Placemark completo del KML
    const placemarkActual = kml.slice(placemarkStart, placemarkEnd);

    // Reconstruir el Placemark con la nueva descripción
    const nuevoPlacemark = placemarkActual
      .replace(/<name>[^<]*<\/name>/, `<name>${nuevoNombre}</name>`)
      .replace(/<description>[\s\S]*?<\/description>/, `<description>${nuevaDescripcion}</description>`)
      .replace(/<styleUrl>[^<]*<\/styleUrl>/, `<styleUrl>${CATEGORIAS[categoria].styleUrl}</styleUrl>`)
      .replace(/<coordinates>\s*[\d.\-]+,[\d.\-]+(?:,[\d.\-]+)?/, `<coordinates>\n            ${lonStr},${latStr},0`);

    // Reemplazar en el KML
    kml = kml.slice(0, placemarkStart) + nuevoPlacemark + kml.slice(placemarkEnd);

    // Backup + guardar
    backupKML();
    fs.writeFileSync(KML_PATH, kml, 'utf8');

    console.log(`POI actualizado: "${nombreActual.trim()}" -> "${nuevoNombre}"`);

    res.json({
      ok: true,
      poi: {
        nombre: nuevoNombre,
        lat: latStr,
        lon: lonStr,
        categoria: CATEGORIAS[categoria].label,
        icon: CATEGORIAS[categoria].icon
      }
    });

  } catch (err) {
    console.error('Error al actualizar POI:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/poi — eliminar un POI por nombre exacto
app.delete('/api/poi', (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) {
    return res.status(400).json({ ok: false, error: 'Nombre es obligatorio' });
  }

  try {
    verificarKML();

    const kml = fs.readFileSync(KML_PATH, 'utf8');
    const nameTag = `<name>${nombre}</name>`;
    const nameIndex = kml.indexOf(nameTag);

    if (nameIndex === -1) {
      return res.status(404).json({ ok: false, error: 'POI no encontrado' });
    }

    const placemarkStart = kml.lastIndexOf('<Placemark>', nameIndex);
    const placemarkEnd = kml.indexOf('</Placemark>', nameIndex) + '</Placemark>'.length;

    // Eliminar el Placemark completo
    let newKml = kml.slice(0, placemarkStart) + kml.slice(placemarkEnd);

    // Limpiar líneas vacías excesivas
    newKml = newKml.replace(/\n{3,}/g, '\n\n');

    backupKML();
    fs.writeFileSync(KML_PATH, newKml, 'utf8');

    console.log(`POI eliminado: ${nombre}`);
    res.json({ ok: true, mensaje: 'POI eliminado correctamente' });

  } catch (err) {
    console.error('Error al eliminar POI:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`Servidor carga-poi corriendo en http://localhost:${PORT}`);
  console.log(`KML: ${KML_PATH}`);
});
