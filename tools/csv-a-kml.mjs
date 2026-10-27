// Convierte un CSV de POIs (Tipo de POIs, Latitud, Longitud, Razón Social) en un KML
// para el mapa, con un único ícono de /poi/icons/.
//
// Uso: node tools/csv-a-kml.mjs <entrada.csv> <salida.kml> "<Nombre del KML>" <ícono>
// Ej.: node tools/csv-a-kml.mjs data/estaciones_de_servicio.csv \
//        data/estaciones_de_servicio.kml "Estaciones de servicio" gasolinera
//
// - Nombre de cada POI: la razón social; si falta, el tipo.
// - Descripción: el tipo (el popup del mapa solo se abre si hay descripción).
// - Coordenadas repetidas exactas: queda la primera fila.

import { readFileSync, writeFileSync } from 'node:fs';

const [entrada, salida, nombreKml, icono] = process.argv.slice(2);
if (!entrada || !salida || !nombreKml || !icono) {
  console.error('Uso: node tools/csv-a-kml.mjs <entrada.csv> <salida.kml> "<Nombre>" <ícono>');
  process.exit(1);
}

// CSV simple con comillas opcionales (RFC 4180).
const parseCsv = (texto) => {
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i += 1;
      } else if (c === '"') {
        comillas = false;
      } else {
        campo += c;
      }
    } else if (c === '"') {
      comillas = true;
    } else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i += 1;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += c;
    }
  }
  if (campo || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas.filter((f) => f.some((valor) => valor.trim()));
};

const xml = (texto) =>
  texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const [, ...filas] = parseCsv(readFileSync(entrada, 'utf8').replace(/^﻿/, ''));

const vistos = new Set();
const placemarks = [];
let repetidos = 0;
filas.forEach((fila, indice) => {
  const [tipo, latitud, longitud, razonSocial] = fila.map((valor) => (valor ?? '').trim());
  const lat = Number(latitud);
  const lon = Number(longitud);
  if (!latitud || !longitud || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn(`Fila ${indice + 2}: coordenadas inválidas, se omite`);
    return;
  }
  const clave = `${lat},${lon}`;
  if (vistos.has(clave)) {
    repetidos += 1;
    return;
  }
  vistos.add(clave);
  placemarks.push(
    [
      '      <Placemark>',
      `        <name>${xml(razonSocial || tipo)}</name>`,
      `        <description>${xml(tipo)}</description>`,
      `        <styleUrl>#rt-${icono}</styleUrl>`,
      '        <Point>',
      `          <coordinates>${lon},${lat},0</coordinates>`,
      '        </Point>',
      '      </Placemark>',
    ].join('\n'),
  );
});

const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(nombreKml)}</name>
    <Style id="rt-${icono}">
      <IconStyle>
        <scale>0.4</scale>
        <Icon>
          <href>/poi/icons/${icono}.png</href>
        </Icon>
      </IconStyle>
      <LabelStyle>
        <scale>0</scale>
      </LabelStyle>
    </Style>
    <Folder>
      <name>${xml(nombreKml)}</name>
${placemarks.join('\n')}
    </Folder>
  </Document>
</kml>
`;

writeFileSync(salida, kml);
console.log(`${placemarks.length} POIs escritos en ${salida} (${repetidos} repetidos omitidos)`);
