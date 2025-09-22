export const config = { runtime: 'edge' };

/* ----------------------------- helpers ----------------------------- */
function toNumber(x: any) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Minimal + tolerant: TT/DD, TT//, and US T-group fallback
function extractTempC(raw?: string): number | null {
  if (!raw || typeof raw !== 'string') return null;

  // Primary: match TT/DD with optional minus and allow missing dewpoint (// or ///)
  // Examples: "13/07", "M02/M05", "10//", "03///"
  const m = raw.match(/(?:^|\s)(M?\d{1,2})\/(M?\d{1,2}|\/\/\/?)(?=\s|$)/);
  if (m) {
    const tStr = m[1];
    const val = tStr[0] === 'M' ? -parseInt(tStr.slice(1), 10) : parseInt(tStr, 10);
    return Number.isFinite(val) ? val : null;
  }

  // Fallback: scan tokens (some feeds can insert non-standard whitespace)
  for (const tok of raw.split(/\s+/)) {
    const mm = tok.match(/^(M?\d{1,2})\/(M?\d{1,2}|\/\/\/?)$/);
    if (mm) {
      const tStr = mm[1];
      const val = tStr[0] === 'M' ? -parseInt(tStr.slice(1), 10) : parseInt(tStr, 10);
      return Number.isFinite(val) ? val : null;
    }
  }

  // Fallback #2: US "T-group" with tenths (e.g., T01234567 => +1.2°C, +3.4°C)
  const Tg = raw.match(/\bT(\d{8})\b/);
  if (Tg) {
    const s = Tg[1];
    const signT = s[0] === '1' ? -1 : 1;
    const tTenths = parseInt(s.slice(1, 4), 10); // first 3 digits after sign are temp * 10
    if (Number.isFinite(tTenths)) {
      return Math.round(signT * (tTenths / 10));
    }
  }

  return null;
}

// Parse from raw METAR string (wind + altimeter; temp via extractTempC)
function parseFromRaw(raw?: string) {
  if (!raw || typeof raw !== 'string') return {};

  // WIND: e.g., "02008KT", "VRB04KT", optionally gusts "22012G20KT"
  const windRe = /\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/;
  const windMatch = raw.match(windRe);
  let wind_dir_degrees: number | null = null;
  let wind_speed_kt: number | null = null;
  if (windMatch) {
    const dir = windMatch[1];
    const spd = windMatch[2];
    wind_dir_degrees = dir === 'VRB' ? null : toNumber(dir);
    wind_speed_kt = toNumber(spd);
  }

  // TEMPERATURE/DEWPOINT
  const tempC = extractTempC(raw);

  // ALTIMETER: "Q1027" (hPa) or "A2992" (inHg * 100)
  let altim_in_hg: number | null = null;
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

// NOAA text -> normalized record array
function parseNOAAMetarText(text: string) {
  const lines = text.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const raw = lines[lines.length - 1] || '';
  const stationMatch = raw.match(/^[A-Z]{4}\b/);
  const station = stationMatch ? stationMatch[0] : null;

  // timestamp line like "2025/09/22 10:20"
  const timeMatch = lines[0]?.match(/\b(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\b/);
  let obsTime: number | null = null;
  if (timeMatch) {
    const [, y, m, d, hh, mm] = timeMatch.map(Number);
    obsTime = Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000);
  }

  const fromRaw = parseFromRaw(raw);
  return [{
    source: 'noaa-txt',
    station,
    obsTime,
    tempC: fromRaw.tempC ?? null,
    altim_in_hg: fromRaw.altim_in_hg ?? null,
    wind_dir_degrees: fromRaw.wind_dir_degrees ?? null,
    wind_speed_kt: fromRaw.wind_speed_kt ?? null,
    raw,
  }];
}

// AWC JSON item -> normalized (then fill from raw if missing)
function normalizeAWC(item: any) {
  const station = item?.station_id ?? item?.station ?? item?.icaoId ?? null;
  const raw = item?.raw_text ?? item?.raw ?? item?.rawOb ?? null;

  let obsTime: number | null = null;
  const tCandidate = item?.obsTime ?? item?.observation_time ?? item?.time ?? item?.meta?.obsTime ?? null;
  if (typeof tCandidate === 'number') {
    obsTime = tCandidate > 1e12 ? Math.floor(tCandidate / 1000) : tCandidate;
  } else if (typeof tCandidate === 'string') {
    const ms = Date.parse(tCandidate);
    obsTime = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  let tempC =
    toNumber(item?.temp) ??
    toNumber(item?.temperature) ??
    toNumber(item?.obs?.temp) ?? null;

  let altim_in_hg =
    toNumber(item?.altim_in_hg) ??
    toNumber(item?.altimeter?.in) ?? null;

  let wind_dir_degrees =
    toNumber(item?.wind_dir_degrees) ??
    toNumber(item?.wind_dir) ??
    toNumber(item?.wind?.degrees) ?? null;

  let wind_speed_kt =
    toNumber(item?.wind_speed_kt) ??
    toNumber(item?.wind?.speed_kts) ??
    toNumber(item?.wind?.speed_kt) ?? null;

  // Enrich from raw if any are missing (always use simple raw extraction for temp)
  if (raw) {
    const fromRaw = parseFromRaw(raw);
    if (tempC == null && fromRaw.tempC != null) tempC = fromRaw.tempC;
    if (altim_in_hg == null && fromRaw.altim_in_hg != null) altim_in_hg = fromRaw.altim_in_hg;
    if (wind_dir_degrees == null && fromRaw.wind_dir_degrees != null) wind_dir_degrees = fromRaw.wind_dir_degrees;
    if (wind_speed_kt == null && fromRaw.wind_speed_kt != null) wind_speed_kt = fromRaw.wind_speed_kt;
  }

  return { source: 'awc-json', station, obsTime, tempC, altim_in_hg, wind_dir_degrees, wind_speed_kt, raw };
}

async function fetchAWC(icao: string) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json`;
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'C172M-Perf-App/edge' } });
  if (!r.ok) throw new Error(`AWC HTTP ${r.status}`);
  const data = await r.json();
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(normalizeAWC);
}

async function fetchNOAA(icao: string) {
  const url = `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`;
  const r = await fetch(url, { headers: { accept: 'text/plain', 'user-agent': 'C172M-Perf-App/edge' } });
  if (!r.ok) throw new Error(`NOAA HTTP ${r.status}`);
  const txt = await r.text();
  return parseNOAAMetarText(txt);
}

/* ------------------------------ handler ----------------------------- */
export default async function handler(req: Request) {
  const { searchParams } = new URL(req.url);
  const icao = (searchParams.get('icao') || '').toUpperCase();

  if (!icao || icao.length !== 4) {
    return new Response(JSON.stringify({ error: 'Provide ?icao=XXXX (4-letter ICAO)' }), {
      status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  try {
    try {
      const out = await fetchAWC(icao);
      return new Response(JSON.stringify(out), {
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    } catch {
      const out = await fetchNOAA(icao);
      return new Response(JSON.stringify(out), {
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
}
