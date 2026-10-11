import React, {useId, useState} from 'react';
import styles from './styles.module.css';
export default function ReferenceExample() {
  const [tree,setTree]=useState(false), id=useId();
  return <figure className={styles.figure}>
    <figcaption>Same objects, different relationships</figcaption>
    <div className={styles.buttons}><button onClick={()=>setTree(false)} aria-pressed={!tree}>Actual references</button><button onClick={()=>setTree(true)} aria-pressed={tree}>Dominator relationships</button></div>
    <div className={styles.canvas} tabIndex={0} role="region" aria-label="Object relationship diagram; scroll horizontally on narrow screens">
    <svg viewBox="0 0 500 340" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>{tree?'Dominator relationships':'Actual object references'}</title>
      <desc id={`${id}-desc`}>{tree?'Root dominates Owner. Owner immediately dominates both Second and Payload.':'Root points to Owner. Owner points to Second and Payload; Second also points to the same Payload.'}</desc>
      <defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="var(--ifm-color-primary)" strokeWidth="1.5" /></marker></defs>
      <g className={tree?styles.tree:styles.edges} markerEnd={`url(#${id}-arrow)`}>
        <path d="M 250 56 L 250 102" /><path d="M 216 156 L 147 230" /><path d="M 284 156 L 353 230" />
        {!tree && <path d="M 187 259 L 310 259" />}
      </g>
      {[[250,35,'Root'],[250,130,'Owner'],[125,260,'Second'],[375,260,'Payload']].map(([x,y,label])=><g key={label}>
        <rect x={Number(x)-62} y={Number(y)-22} width="124" height="48" rx="10" className={styles.side}/><rect x={Number(x)-62} y={Number(y)-26} width="124" height="48" rx="10" className={styles.node}/>
        <text x={x} y={Number(y)+4} textAnchor="middle">{label}</text>
      </g>)}
      <text x="250" y="324" textAnchor="middle" className={styles.caption}>{tree?'Dashed arrows mean immediate domination.':'Arrows are references. Payload is rendered once.'}</text>
    </svg></div>
    <p>Owner dominates Payload even though Second also references it. Domination is not a direct-field relationship.</p>
  </figure>;
}
