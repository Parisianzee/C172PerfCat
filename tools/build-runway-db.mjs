import { writeFile, access } from 'node:fs/promises';
import { constants, createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetch } from 'undici';

const TMP = tmpdir();

// Allow offline local CSVs if present in project root
const LOCAL_AIRPORTS = path.resolve('airports.csv');
const LOCAL_RUNWAYS  = path.resolve('runways.csv');

const airportsCSV = path.join(TMP, 'airports.csv');
const runwaysCSV  = path.join(TMP, 'runways.csv');

// Primary + fallbacks
const SOURCES = {
  airports: [
    'https://davidmegginson.github.io/ourairports-data/airports.csv',
    'https://ourairports.com/data/airports.csv',
    'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv',
  ],
  runways: [
    'https://davidmegginson.github.io/ourairports-data/runways.csv',
    'https://ourairports.com/data/runways.csv',
    'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv',
  ],
};

async function fileExists(p) {
  try { await access(p, constants.R_OK); return true; } catch { return false; }
}

async function downloadWithFallback(urls, file) {
  let lastErr;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { accept: 'text/csv' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
      await pipeline(r.body, createWriteStream(file));
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// tiny CSV line parser (quotes + commas)
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === ',' && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function buildAirportsMap(fromFile) {
  const map = {};
  const stream = createReadStream(fromFile, 'utf8');
  let header = null;
  for await (const chunk of stream) {
    const lines = String(chunk).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const cols = parseCSVLine(line);
      if (!header) { header = cols; continue; }
      const rec = Object.fromEntries(cols.map((v, i) => [header[i], v]));
      const ident = rec.ident?.toUpperCase();
      if (!ident || ident.length !== 4) continue;
      const elev = rec.elevation_ft ? Number(rec.elevation_ft) : null;
      map[ident] = { elevation_ft: Number.isFinite(elev) ? elev : 0 };
    }
  }
  return map;
}

async function buildRunwaysMap(fromFile) {
  const map = {};
  const stream = createReadStream(fromFile, 'utf8');
  let header = null;
  for await (const chunk of stream) {
    const lines = String(chunk).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const cols = parseCSVLine(line);
      if (!header) { header = cols; continue; }
      const r = Object.fromEntries(cols.map((v, i) => [header[i], v]));
      const icao = r.airport_ident?.toUpperCase();
      if (!icao || icao.length !== 4) continue;
      const list = map[icao] || (map[icao] = []);
      if (r.le_ident && r.le_heading_degT) list.push({ ident: r.le_ident, heading_degT: Number(r.le_heading_degT) });
      if (r.he_ident && r.he_heading_degT) list.push({ ident: r.he_ident, heading_degT: Number(r.he_heading_degT) });
    }
  }
  return map;
}

async function main() {
  // Airports CSV
  if (await fileExists(LOCAL_AIRPORTS)) {
    console.log(`Using local ${LOCAL_AIRPORTS}`);
  } else {
    console.log('Downloading airports.csv (with fallbacks)…');
    await downloadWithFallback(SOURCES.airports, airportsCSV);
  }

  // Runways CSV
  if (await fileExists(LOCAL_RUNWAYS)) {
    console.log(`Using local ${LOCAL_RUNWAYS}`);
  } else {
    console.log('Downloading runways.csv (with fallbacks)…');
    await downloadWithFallback(SOURCES.runways, runwaysCSV);
  }

  const airportsFile = (await fileExists(LOCAL_AIRPORTS)) ? LOCAL_AIRPORTS : airportsCSV;
  const runwaysFile  = (await fileExists(LOCAL_RUNWAYS))  ? LOCAL_RUNWAYS  : runwaysCSV;

  console.log('Building airports map…');
  const airports = await buildAirportsMap(airportsFile);
  console.log('Building runways map…');
  const runways = await buildRunwaysMap(runwaysFile);

  await writeFile('src/data/airports.json', JSON.stringify(airports, null, 2));
  await writeFile('src/data/runways.json', JSON.stringify(runways, null, 2));
  console.log('Wrote src/data/airports.json and src/data/runways.json');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
