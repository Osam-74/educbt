import Image from 'next/image';
import type { HelpBlock } from '@/lib/help/types';

/**
 * Inline text: **bold** (an on-screen label), *italic* (another article's
 * title) and `code` (something to type or paste). Parsed into React nodes, never injected as HTML, so article text
 * can never become markup.
 */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code>
        : p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong>
        : p.startsWith('*') ? <em key={i}>{p.slice(1, -1)}</em>
        : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function Blocks({ blocks }: { blocks: HelpBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'p': return <p key={i}><Inline text={b.text} /></p>;
          case 'h': return <h2 key={i} id={`s-${i}`}><Inline text={b.text} /></h2>;
          case 'steps': return (
            <section key={i} className="hc-steps">
              {b.title && <h3>{b.title}</h3>}
              <ol>{b.items.map((s, j) => <li key={j}><Inline text={s} /></li>)}</ol>
            </section>
          );
          case 'list': return <ul key={i}>{b.items.map((s, j) => <li key={j}><Inline text={s} /></li>)}</ul>;
          case 'note': return <aside key={i} className="hc-callout hc-callout--note" role="note"><strong>Note</strong><p><Inline text={b.text} /></p></aside>;
          case 'warning': return <aside key={i} className="hc-callout hc-callout--warn" role="note"><strong>Important</strong><p><Inline text={b.text} /></p></aside>;
          case 'figure': return b.figure.src ? (
            <figure key={i} className="hc-figure">
              <Image src={b.figure.src} alt={b.figure.alt} width={b.figure.width ?? 1200} height={b.figure.height ?? 700} sizes="(max-width: 760px) 100vw, 760px" />
              {b.figure.caption && <figcaption>{b.figure.caption}</figcaption>}
            </figure>
          ) : null; // no real screenshot yet: show nothing rather than a fake one
          case 'table': return (
            <div key={i} className="hc-tablewrap" tabIndex={0}>
              <table>
                <thead><tr>{b.head.map((h, j) => <th key={j} scope="col">{h}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline text={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
      })}
    </>
  );
}
