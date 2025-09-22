import express from 'express';
import { fetch } from 'undici';

const app = express();
const PORT = process.env.PORT || 8787;

/* ----------------------------- helpers ----------------------------- */
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Parse fields from a raw METAR string (works for both AWC raw_text and NOAA TXT lines)
function parseFromRaw(raw) {
  if (!raw || typeof raw !== 'string') return {};

  // WIND: e.g., "02008KT", "VRB04KT", optionally with gusts: "22012G20KT"
  const windMatch = raw.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  let wind_dir_degrees = null;
  let wind_speed_kt = null;
  if (windMatch) {
    const dir = windMatch[1];
    const spd = windMatch[2];
    wind_dir_degrees = dir === 'VRB' ? null : toNumber(dir);
    wind_speed_kt = toNumber(spd);
  }

  // TEMPERATURE/DEWPOINT: "13/06" or "M02/M05"
  const tMatch = raw.match(/\b(M?\d{1,2})\/(M?\d{1,2})\b/);
  let tempC = null;
  if (tMatch) {
    const t = tMatch[1];
    tempC = t.startsWith('M') ? -toNumber(t.slice(1)) : toNumber(t);
  }

  // ALTIMETER: "Q1027" (hPa) or "A2992" (inHg * 100)
  let altim_in_hg = null;
  const qMatch = raw.match(/\bQ(\d{4})\b/);
  const aMatch = raw.match(/\bA(\d{4})\b/);
  if (qMatch) {
    const hPa = toNumber(qMatch[1]);
    if (hPa != null) altim_in_hg = Number((hPa * 0.0295299831).toFixed(2));
  } else if (aMatch) {
    const hund = toNumber(aMatch[1]);
    if (hund != null) altim_in_hg = Number((hund / 100).toFixed(2));
  }

  return { tempC, altim_in_hg, wind_dir_degrees, wind_speed_kt };
}

// NOAA text → normalized record
function parseNOAAMetarText(text) {
  const lines = text.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const raw = lines[lines.length - 1] || '';
  const stationMatch = raw.match(/^[A-Z]{4}\b/);
  const station = stationMatch ? stationMatch[0] : null;

  // timestamp line like "2025/09/22 10:20"
  const timeMatch = lines[0]?.match(/\b(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\b/);
  let obsTime = null;
  if (timeMatch) {
    const [_, y, m, d, hh, mm] = timeMatch.map(Number);
    obsTime = Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000);
  }

  // try to parse fields from raw
  const parsed = parseFromRaw(raw);

  return {
    source: 'noaa-txt',
    station,
    obsTime,
    tempC: parsed.tempC ?? null,
    altim_in_hg: parsed.altim_in_hg ?? null,
    wind_dir_degrees: parsed.wind_dir_degrees ?? null,
    wind_speed_kt: parsed.wind_speed_kt ?? null,
    raw,
  };
}

// AWC JSON item → normalized (then enrich from raw if needed)
function normalizeAWC(item) {
  const station = item?.station_id ?? item?.station ?? item?.icaoId ?? null;
  const raw = item?.raw_text ?? item?.raw ?? item?.rawOb ?? null;

  // obsTime can be epoch seconds, millis, or ISO
  let obsTime = null;
  const tCandidate = item?.obsTime ?? item?.observation_time ?? item?.time ?? item?.meta?.obsTime ?? null;
  if (typeof tCandidate === 'number') {
    obsTime = tCandidate > 1e12 ? Math.floor(tCandidate / 1000) : tCandidate;
  } else if (typeof tCandidate === 'string') {
    const ms = Date.parse(tCandidate);
    obsTime = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  // straight fields if present
  let tempC =
    toNumber(item?.temp) ??
    toNumber(item?.temperature) ??
    toNumber(item?.obs?.temp) ??
    null;

  let altim_in_hg =
    toNumber(item?.altim_in_hg) ??
    toNumber(item?.altimeter?.in) ??
    null;

  let wind_dir_degrees =
    toNumber(item?.wind_dir_degrees) ??
    toNumber(item?.wind_dir) ??
    toNumber(item?.wind?.degrees) ??
    null;

  let wind_speed_kt =
    toNumber(item?.wind_speed_kt) ??
    toNumber(item?.wind?.speed_kts) ??
    toNumber(item?.wind?.speed_kt) ??
    null;

  // enrich from raw if missing
  if (raw && (tempC == null || altim_in_hg == null || wind_dir_degrees == null || wind_speed_kt == null)) {
    const fromRaw = parseFromRaw(raw);
    if (tempC == null && fromRaw.tempC != null) tempC = fromRaw.tempC;
    if (altim_in_hg == null && fromRaw.altim_in_hg != null) altim_in_hg = fromRaw.altim_in_hg;
    if (wind_dir_degrees == null && fromRaw.wind_dir_degrees != null) wind_dir_degrees = fromRaw.wind_dir_degrees;
    if (wind_speed_kt == null && fromRaw.wind_speed_kt != null) wind_speed_kt = fromRaw.wind_speed_kt;
  }

  return {
    source: 'awc-json',
    station,
    obsTime,
    tempC,
    altim_in_hg,
    wind_dir_degrees,
    wind_speed_kt,
    raw,
  };
}

/* ------------------------- upstream fetchers ------------------------ */
async function fetchAWC(icao) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json`;
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'C172M-Perf-App/1.0 (dev proxy)' },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(`AWC HTTP ${r.status}`);
    err.details = text.slice(0, 500);
    throw err;
  }
  const data = await r.json();
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(normalizeAWC);
}

async function fetchNOAA(icao) {
  const url = `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`;
  const r = await fetch(url, {
    headers: { accept: 'text/plain', 'user-agent': 'C172M-Perf-App/1.0 (dev proxy)' },
  });
  if (!r.ok) throw new Error(`NOAA HTTP ${r.status}`);
  const txt = await r.text();
  return [parseNOAAMetarText(txt)];
}

/* ------------------------------ route ------------------------------ */
app.get('/api/metar', async (req, res) => {
  const icao = String(req.query.icao || '').toUpperCase();
  if (!icao || icao.length !== 4) {
    res.status(400).json({ error: 'Provide ?icao=XXXX (4-letter ICAO)' });
    return;
  }
  try {
    // AWC first
    try {
      const out = await fetchAWC(icao);
      res.setHeader('cache-control', 'no-store');
      res.json(out);
      return;
    } catch (e) {
      console.warn(`[METAR] AWC failed for ${icao}:`, e.message, e.details || '');
    }
    // NOAA fallback
    try {
      const out = await fetchNOAA(icao);
      res.setHeader('cache-control', 'no-store');
      res.json(out);
      return;
    } catch (e) {
      console.warn(`[METAR] NOAA TXT failed for ${icao}:`, e.message);
    }
    res.status(502).json({ error: 'Both AWC and NOAA failed' });
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.use(express.static('dist'));

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
