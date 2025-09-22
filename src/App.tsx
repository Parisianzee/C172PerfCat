import React, { useMemo, useState, useEffect } from 'react';
import NumberInput from '@/components/NumberInput';
import Select from '@/components/Select';
import perfData from '@/data/c172m_takeoff.json';
import runwaysMap from '@/data/runways.json';
import airportsMap from '@/data/airports.json';
import type { DataSchema } from '@/types';
import { calculate } from '@/lib/perf';

const dataset = perfData as DataSchema;

// helpers
const LB_PER_KG = 2.20462262185;
const M_PER_FT = 0.3048;
function lbFromKg(kg: number) { return kg * LB_PER_KG; }
function mFromFt(ft: number | null) { return ft == null ? null : Math.round(ft * M_PER_FT); }
function normDeg(delta: number) { return ((delta + 180) % 360 + 360) % 360 - 180; } // [-180,180]

// local JSON shapes
type RunwayEntry = { ident: string; heading_degT: number };
const RUNWAYS = runwaysMap as Record<string, RunwayEntry[]>;
const AIRPORTS = airportsMap as Record<string, { elevation_ft: number }>;

export default function App() {
  // metric-first inputs
  const [icao, setIcao] = useState<string>('EGLL');
  const [selectedRunway, setSelectedRunway] = useState<string>('');
  const [pressureAltitudeFt, setPA] = useState<number>(0);
  const [oatC, setOAT] = useState<number>(15);
  const [weightKg, setWeightKg] = useState<number>(950);
  const [windType, setWindType] = useState<'head' | 'tail'>('head');
  const [windMagKt, setWindMagKt] = useState<number>(0);
  const [dryGrass, setGrass] = useState<boolean>(false);

  // bounds
  const paMin = 0, paMax = 8000, tMin = 0, tMax = 40;
  const wMinLb = useMemo(() => Math.min(...dataset.grid.weights.map(w => w.weight_lb)), []);
  const wMaxLb = useMemo(() => Math.max(...dataset.grid.weights.map(w => w.weight_lb)), []);
  const wMinKg = Math.round(wMinLb / LB_PER_KG);
  const wMaxKg = Math.round(wMaxLb / LB_PER_KG);

  // state
  const [result, setResult] = useState<ReturnType<typeof calculate> | null>(null);
  const [metar, setMetar] = useState<any>(null);
  const [metarStatus, setMetarStatus] = useState<string>('');

  // runways for current ICAO
  const runways = (RUNWAYS[icao?.toUpperCase()] ?? []) as RunwayEntry[];

  useEffect(() => {
    if (runways.length > 0) setSelectedRunway(runways[0].ident);
    else setSelectedRunway('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao]);

  function onCalculate() {
    const weightLb = lbFromKg(Number.isFinite(weightKg) ? weightKg : 0);
    const windKtSigned = windType === 'head' ? Math.abs(windMagKt) : -Math.abs(windMagKt);
    const res = calculate(dataset, { pressureAltitudeFt, oatC, weightLb, windKtSigned, dryGrass });
    setResult(res);
  }

  async function fetchMETAR() {
    const code = icao.trim().toUpperCase();
    if (!code || code.length !== 4) {
      setMetarStatus('Enter a 4-letter ICAO (e.g., EGLL)');
      return;
    }
    try {
      setMetarStatus('Fetching…');
      const r = await fetch(`/api/metar?icao=${encodeURIComponent(code)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      // AWC returns an array; our proxy also returns an array for NOAA fallback
      const item = Array.isArray(json) ? json[0] : json?.[0] ?? json;
      setMetar(item);
      setMetarStatus('');

      // ---- Temperature (use normalized tempC first, then other shapes)
      const tempC =
        (typeof item?.tempC === 'number' ? item.tempC : null) ??
        (typeof item?.temp === 'number' ? item.temp : null) ??
        (typeof item?.temperature === 'number' ? item.temperature : null) ??
        (typeof item?.obs?.temp === 'number' ? item.obs.temp : null) ??
        null;

      if (typeof tempC === 'number') setOAT(Math.round(tempC));


      // ---- Pressure altitude (field elevation + altimeter, if both present)
      const elev = AIRPORTS[code]?.elevation_ft ?? null;
      const altim_in_hg =
        (typeof item?.altim_in_hg === 'number' ? item.altim_in_hg : null) ??
        (typeof item?.altimeter?.in === 'number' ? item.altimeter.in : null) ??
        null;
      if (typeof elev === 'number' && typeof altim_in_hg === 'number') {
        const pa = Math.round(elev + (29.92 - altim_in_hg) * 1000);
        setPA(pa);
      }

      // ---- Wind extraction (covers multiple JSON shapes + calm/VRB)
      const windDirTrue =
        (typeof item?.wind_dir_degrees === 'number' ? item.wind_dir_degrees : null) ??
        (typeof item?.wind_dir === 'number' ? item.wind_dir : null) ??
        (typeof item?.wind?.degrees === 'number' ? item.wind.degrees : null) ??
        null;

      const windKt =
        (typeof item?.wind_speed_kt === 'number' ? item.wind_speed_kt : null) ??
        (typeof item?.wind?.speed_kts === 'number' ? item.wind.speed_kts : null) ??
        (typeof item?.wind?.speed_kt === 'number' ? item.wind.speed_kt : null) ??
        null;

      if (selectedRunway) {
        const rw = runways.find(rw => rw.ident === selectedRunway);
        if (rw) {
          let headComp: number | null = null;

          if (typeof windKt === 'number' && typeof windDirTrue === 'number') {
            const delta = normDeg(windDirTrue - rw.heading_degT);
            headComp = Math.round(windKt * Math.cos((Math.PI / 180) * delta));
          } else if (typeof windKt === 'number') {
            // VRB direction: neutral head/tail component (conservative)
            headComp = 0;
          }

          if (typeof headComp === 'number') {
            const isHead = headComp >= 0;
            setWindType(isHead ? 'head' : 'tail');
            setWindMagKt(Math.abs(headComp));
          }
        }
      }
    } catch (e: any) {
      setMetarStatus(`Failed: ${e?.message ?? e}`);
      setMetar(null);
    }
  }

  function onReset() {
    setPA(0); setOAT(15); setWeightKg(950); setWindType('head'); setWindMagKt(0); setGrass(false); setResult(null);
  }

  return (
    <div className="min-h-screen p-6 sm:p-10">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">C172M Takeoff Performance</h1>
          <p className="text-gray-600 mt-1">Metric UI; PA in ft, speeds KIAS. METAR + runway components.</p>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">ICAO</span>
            <input
              value={icao}
              onChange={e => setIcao(e.target.value.toUpperCase())}
              className="w-full rounded-xl border px-3 py-2 border-gray-300 outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="EGLL"
              maxLength={4}
            />
          </label>

          <Select
            label="Runway"
            value={selectedRunway}
            onChange={e => setSelectedRunway(e.target.value)}
            options={
              runways.length
                ? runways.map(r => ({ label: `${r.ident} (${Math.round(r.heading_degT)}°T)`, value: r.ident }))
                : [{ label: '— no data —', value: '' }]
            }
          />

          <NumberInput
            label="Pressure Altitude"
            value={pressureAltitudeFt}
            onChange={e => setPA(Number(e.target.value))}
            min={paMin}
            max={paMax}
            step={100}
            suffix="ft"
          />
          <NumberInput
            label="Outside Air Temperature"
            value={oatC}
            onChange={e => setOAT(Number(e.target.value))}
            min={tMin}
            max={tMax}
            step={1}
            suffix="°C"
          />
          <NumberInput
            label="Weight"
            value={weightKg}
            onChange={e => setWeightKg(Number(e.target.value))}
            min={wMinKg}
            max={wMaxKg}
            step={1}
            suffix="kg"
          />

          <div className="grid grid-cols-2 gap-3">
            <Select<'head' | 'tail'>
              label="Wind Type"
              value={windType}
              onChange={e => setWindType(e.target.value as 'head' | 'tail')}
              options={[
                { label: 'Headwind', value: 'head' },
                { label: 'Tailwind', value: 'tail' },
              ]}
            />
            <NumberInput
              label="Wind Magnitude"
              value={windMagKt}
              onChange={e => setWindMagKt(Number(e.target.value))}
              min={0}
              step={1}
              suffix="kt"
            />
          </div>

          <label className="flex items-center gap-2 mt-2">
            <input
              type="checkbox"
              checked={dryGrass}
              onChange={e => setGrass(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm text-gray-800">Dry grass surface</span>
          </label>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            onClick={fetchMETAR}
            className="rounded-xl bg-emerald-600 text-white px-5 py-2 font-medium hover:bg-emerald-700"
          >
            Fetch METAR
          </button>
          <button
            onClick={onCalculate}
            className="rounded-xl bg-blue-600 text-white px-5 py-2 font-medium hover:bg-blue-700"
          >
            Calculate
          </button>
          <button
            onClick={onReset}
            className="rounded-xl bg-gray-200 text-gray-800 px-5 py-2 font-medium hover:bg-gray-300"
          >
            Reset
          </button>
        </div>

        {metarStatus && <p className="mt-3 text-sm text-gray-600">{metarStatus}</p>}
        {metar && (
          <pre className="mt-3 text-xs bg-gray-50 border rounded-xl p-3 overflow-auto">
{JSON.stringify({
  station: metar?.station_id ?? metar?.station ?? null,
  obsTime: metar?.obsTime ?? metar?.time ?? null,
  tempC: metar?.temp ?? metar?.temperature ?? metar?.obs?.temp ?? null,
  altim_in_hg: metar?.altim_in_hg ?? metar?.altimeter?.in ?? null,
  wind_dir_degrees: metar?.wind_dir_degrees ?? metar?.wind_dir ?? metar?.wind?.degrees ?? null,
  wind_speed_kt: metar?.wind_speed_kt ?? metar?.wind?.speed_kts ?? metar?.wind?.speed_kt ?? null,
  raw: metar?.raw_text ?? metar?.raw ?? null
}, null, 2)}
          </pre>
        )}

        {result && (
          <section className="mt-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-2xl border p-4 bg-white">
                <h2 className="font-semibold mb-2">Ground Roll</h2>
                <p className="text-3xl font-bold">
                  {mFromFt(result.groundRollFt) == null ? '—' : `${mFromFt(result.groundRollFt)} m`}
                </p>
              </div>
              <div className="rounded-2xl border p-4 bg-white">
                <h2 className="font-semibold mb-2">Over 15 m Obstacle (50 ft)</h2>
                <p className="text-3xl font-bold">
                  {mFromFt(result.toClear50Ft) == null ? '—' : `${mFromFt(result.toClear50Ft)} m`}
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-2xl border p-4 bg-white">
              <h3 className="font-semibold mb-1">Reference Speeds</h3>
              <p className="text-gray-800">
                Liftoff ≈ <b>{result.liftoffKIAS ?? '—'}</b> KIAS; At 50 ft ≈ <b>{result.at50ftKIAS ?? '—'}</b> KIAS.
              </p>
            </div>
            {result.notes.length > 0 && (
              <ul className="mt-4 list-disc pl-6 text-sm text-gray-700">
                {result.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
          </section>
        )}

        <footer className="mt-10 text-xs text-gray-500">
          <p>
            METAR via local proxy; runways & elevation from OurAirports (true headings).
            Distances in meters; calculations use POH (imperial) internally.
          </p>
        </footer>
      </div>
    </div>
  );
}
