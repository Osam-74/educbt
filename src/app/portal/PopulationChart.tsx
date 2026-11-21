import { axisTop, barLabel, shortLabel, totals, type ClassPopulation } from '@/lib/population/rules';
import './population-chart.css';

/**
 * Enrolled students by class, stacked by gender. Drawn on the server as plain SVG (no chart library), so it also prints.
 * A hidden table carries the same numbers for screen readers. The tooltip is the browser's own <title>, so it works with
 * a mouse, a finger and the keyboard without any script.
 */
const ACCENTS = ['#2f7d4f', '#2b7bb9', '#e0803a', '#8e5bb5', '#d1495b', '#1f9e9a', '#c9a227', '#5b6bd6'];
const SLOT = 64, BAR = 36, PLOT_H = 220, TOP = 22, RIGHT = 14;

export default function PopulationChart({ classes }: { classes: ClassPopulation[] }) {
  if (classes.length === 0) return <p className="sa-empty" data-testid="pop-empty">No enrolled students in the current session yet.</p>;

  const t = totals(classes);
  const top = axisTop(Math.max(1, ...classes.map((c) => c.total)));
  const longest = Math.max(1, ...classes.map((c) => [...shortLabel(c.name)].length));
  // A label turned -38 degrees needs about (chars * 6.4px * sin 38deg) of height, plus room for the colour tick.
  const bottom = Math.round(Math.min(150, Math.max(58, 30 + longest * 6.4 * 0.62)));
  // The first label slants left of its bar, so the left gutter must hold its horizontal reach.
  const firstLen = [...shortLabel(classes[0]!.name)].length;
  const left = Math.max(44, Math.ceil(firstLen * 6.4 * 0.79) - Math.floor((SLOT - BAR) / 2) - Math.floor(BAR / 2) + 18);
  const width = left + RIGHT + Math.max(6, classes.length) * SLOT;
  const height = TOP + PLOT_H + bottom;
  const y = (v: number) => TOP + PLOT_H - (v / top) * PLOT_H;

  return (
    <div className="pop-chart" data-testid="pop-chart">
      <div className="pop-legend" aria-hidden="true">
        <span><i style={{ background: 'linear-gradient(135deg,#43a56b,#1f6b41)' }} /> Male <b data-testid="pop-male">{t.male}</b></span>
        <span><i style={{ background: 'linear-gradient(135deg,#f5c25b,#e08a1e)' }} /> Female <b data-testid="pop-female">{t.female}</b></span>
        {t.unknown > 0 ? <span><i style={{ background: '#aab3ad' }} /> Not stated <b data-testid="pop-unknown">{t.unknown}</b></span> : null}
        <span className="pop-legend__total">Total enrolled <b data-testid="pop-total">{t.total}</b></span>
      </div>
      <div className="pop-scroll">
        <div className="pop-stage" style={{ minWidth: left + RIGHT + Math.max(3, classes.length) * 46 }}>
          <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Enrolled students by class and gender" focusable="false">
            <defs>
              <linearGradient id="pop-g-male" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#43a56b" /><stop offset="1" stopColor="#1f6b41" /></linearGradient>
              <linearGradient id="pop-g-female" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f5c25b" /><stop offset="1" stopColor="#e08a1e" /></linearGradient>
              <linearGradient id="pop-g-unknown" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c3cbc6" /><stop offset="1" stopColor="#9aa59e" /></linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <g key={g}>
                <line x1={left} x2={width - RIGHT} y1={y(top * g).toFixed(1)} y2={y(top * g).toFixed(1)} stroke="#e3e9e5" strokeWidth="1" />
                <text x={left - 8} y={(y(top * g) + 4).toFixed(1)} textAnchor="end" fontSize="11" fill="#69766c">{Math.round(top * g)}</text>
              </g>
            ))}
            {classes.map((c, i) => {
              const x = left + i * SLOT + (SLOT - BAR) / 2;
              const accent = ACCENTS[i % ACCENTS.length]!;
              let cum = 0;
              const segs = ([['male', 'url(#pop-g-male)'], ['female', 'url(#pop-g-female)'], ['unknown', 'url(#pop-g-unknown)']] as const)
                .map(([key, fill]) => {
                  const v = c[key]; if (v <= 0) return null;
                  const y1 = y(cum + v), h = y(cum) - y1; cum += v;
                  return { key, fill, v, y1, h };
                }).filter((s): s is NonNullable<typeof s> => s !== null);
              const lx = (x + BAR / 2).toFixed(1), ly = TOP + PLOT_H + 16;
              return (
                <g key={c.classId} className="pop-bar" tabIndex={0} role="img" aria-label={barLabel(c)} data-class={c.classId} data-total={c.total} data-male={c.male} data-female={c.female} data-unknown={c.unknown}>
                  <title>{barLabel(c)}</title>
                  <rect className="pop-hit" x={left + i * SLOT} y={TOP} width={SLOT} height={PLOT_H} fill="transparent" />
                  {segs.map((s) => (
                    <g key={s.key}>
                      <rect className="pop-seg" x={x.toFixed(1)} y={s.y1.toFixed(1)} width={BAR} height={Math.max(0, s.h).toFixed(1)} fill={s.fill} rx="3" data-seg={s.key} />
                      {s.h >= 15 ? <text x={(x + BAR / 2).toFixed(1)} y={(s.y1 + s.h / 2 + 4).toFixed(1)} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fff">{s.v}</text> : null}
                    </g>
                  ))}
                  <text x={(x + BAR / 2).toFixed(1)} y={(y(c.total) - 5).toFixed(1)} textAnchor="middle" fontSize="12" fontWeight="700" fill="#152019">{c.total}</text>
                  <rect x={x.toFixed(1)} y={TOP + PLOT_H + 2} width={BAR} height="4" rx="2" fill={accent} />
                  <text className="pop-xlabel" transform={`translate(${lx},${ly}) rotate(-38)`} textAnchor="end" fontSize="12" fontWeight="600" fill="#37453d" data-label={c.classId}>{shortLabel(c.name)}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <table className="pop-sr-only">
        <caption>Enrolled students by class and gender</caption>
        <thead><tr><th>Class</th><th>Male</th><th>Female</th>{t.unknown > 0 ? <th>Not stated</th> : null}<th>Total</th></tr></thead>
        <tbody>{classes.map((c) => <tr key={c.classId}><th>{c.name}</th><td>{c.male}</td><td>{c.female}</td>{t.unknown > 0 ? <td>{c.unknown}</td> : null}<td>{c.total}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
