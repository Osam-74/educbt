/**
 * Fixed sample documents for the template preview. Every name, mark and number here is invented. They use the real print
 * classes (`doc`, `doc__sheet`, `doc__table`, ...) so print.css and templates.css style them exactly as a school's own.
 */
const SCHOOL = 'Demo International School';
const ADDRESS = '12 Ring Road, Ibadan, Oyo State';
const CONTACT = '0803 000 0000  •  info@demointernational.edu.ng';
const SUBJECTS: Array<[string, number, string]> = [
  ['Mathematics', 78, 'A1'], ['English Language', 71, 'B2'], ['Basic Science', 66, 'B3'], ['Civic Education', 74, 'B2'],
  ['Computer Studies', 81, 'A1'], ['Social Studies', 69, 'B3'], ['Agricultural Science', 63, 'C4'], ['Yoruba', 72, 'B2'],
];

export function DemoReport({ cls }: { cls: string }) {
  return (
    <div className={`doc ${cls}`.trim()}>
      <div className="doc__sheet">
        <div className="doc__wm-fallback" aria-hidden="true"><span>{SCHOOL}</span></div>
        <header className="doc__head">
          <p className="doc__school">{SCHOOL}</p>
          <p className="doc__address">{ADDRESS}</p>
          <p className="doc__contact">{CONTACT}</p>
        </header>
        <p className="doc__title">Terminal Report Sheet</p>
        <table className="doc__bio"><tbody>
          <tr><td className="label">Name</td><td><strong>Inioluwa Olayiwola</strong></td><td className="label">Admission No.</td><td>2026010001</td></tr>
          <tr><td className="label">Class</td><td>JSS 1 A</td><td className="label">Term</td><td>First Term, 2026/2027</td></tr>
        </tbody></table>
        <table className="doc__table">
          <thead><tr><th style={{ textAlign: 'left' }}>Subject</th><th>Score</th><th>Grade</th><th>Class avg</th><th>Highest</th></tr></thead>
          <tbody>
            {SUBJECTS.map(([name, score, grade], i) => (
              <tr key={name}><td className="subject">{name}</td><td>{score}</td><td>{grade}</td><td>{58 + i}.4</td><td>{86 - i}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="doc__summary">Total 574 &nbsp;·&nbsp; Average 71.8% &nbsp;·&nbsp; Position 3rd of 32</p>
      </div>
    </div>
  );
}

export function DemoTranscript({ cls }: { cls: string }) {
  const term = (name: string) => (
    <table className="doc__table" style={{ marginBottom: '3mm' }} key={name}>
      <thead><tr><th style={{ textAlign: 'left' }}>{name} — Subject</th><th style={{ width: '18mm' }}>Score</th><th style={{ width: '18mm' }}>Grade</th></tr></thead>
      <tbody>{SUBJECTS.slice(0, 5).map(([s, sc, g]) => <tr key={s}><td className="subject">{s}</td><td>{sc}</td><td>{g}</td></tr>)}</tbody>
    </table>
  );
  return (
    <div className={`doc ${cls}`.trim()}>
      <div className="doc__sheet">
        <header className="doc__head">
          <p className="doc__school">{SCHOOL}</p><p className="doc__address">{ADDRESS}</p><p className="doc__contact">{CONTACT}</p>
        </header>
        <p className="doc__title">Academic Transcript</p>
        <table className="doc__bio"><tbody>
          <tr><td className="label">Name</td><td><strong>Inioluwa Olayiwola</strong></td><td className="label">Admission No.</td><td>2026010001</td></tr>
          <tr><td className="label">Terms Recorded</td><td>3</td><td className="label">Status</td><td>Active</td></tr>
        </tbody></table>
        <div className="doc__session">
          <h2 style={{ fontSize: '11pt', margin: '5mm 0 2mm' }}>2026/2027 &nbsp;·&nbsp; JSS 1 A</h2>
          {term('First Term')}{term('Second Term')}
        </div>
        <p className="doc__tr-key">Sample transcript: all names and marks are invented.</p>
        <div className="doc__serial"><span>Serial: <strong>TR-2026-00041</strong></span><span>Issued: 2026-11-22</span></div>
      </div>
    </div>
  );
}

export function DemoBroadsheet({ cls }: { cls: string }) {
  const codes = ['MTH', 'ENG', 'BSC', 'SOS', 'CVE', 'CMP', 'AGR', 'YOR'];
  const names = ['Adebayo, Tunde', 'Chukwu, Ngozi', 'Danjuma, Aisha', 'Eze, Chinedu', 'Folarin, Kemi', 'Garba, Ibrahim', 'Hassan, Zainab', 'Ibe, Obinna'];
  const grades = ['A1', 'B2', 'C4', 'B3'];
  return (
    <div className={`doc doc--broadsheet ${cls}`.trim()}>
      <div className="doc__sheet">
        <header className="doc__head"><div><p className="doc__school">{SCHOOL}</p><p className="doc__title">BROADSHEET</p><p className="doc__address">{ADDRESS}</p></div></header>
        <p className="muted doc__meta-line">2026/2027 · First Term · {names.length} students · class average 70.4</p>
        <table className="doc__table">
          <thead><tr><th>Student</th>{codes.map((c) => <th key={c}>{c}</th>)}<th>Total</th><th>Avg</th><th>Pos</th></tr></thead>
          <tbody>
            {names.map((n, i) => (
              <tr key={n}>
                <td style={{ whiteSpace: 'nowrap' }}>{n}</td>
                {codes.map((c, j) => <td key={c}>{50 + ((i * 7 + j * 5) % 48)} <span className="doc__cell-grade">{grades[(i + j) % 4]}</span></td>)}
                <td><strong>{540 + i * 11}</strong></td><td>{60 + i}.2</td><td>{i + 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
