import React, {useEffect, useId, useState} from 'react';
import Link from '@docusaurus/Link';
import {flows, type FlowKind} from './presets';
import styles from './styles.module.css';

function Plate({index, active}: {index: number; active: boolean}) {
  return <svg className={styles.plate} viewBox="0 0 180 100" aria-hidden="true">
    <ellipse cx="90" cy="83" rx="72" ry="9" className={styles.shadow} />
    <path d="M 14 51 L 90 21 L 166 51 L 90 81 Z" className={styles.layer} />
    <path d="M 14 43 L 90 13 L 166 43 L 90 73 Z" className={styles.layer} />
    <path d="M 14 35 L 90 65 L 90 77 L 14 47 Z" className={styles.left} />
    <path d="M 90 65 L 166 35 L 166 47 L 90 77 Z" className={styles.right} />
    <path d="M 14 35 L 90 5 L 166 35 L 90 65 Z" className={active ? styles.activeTop : styles.top} />
    {index === 1 ? <g className={styles.graph}>
      <path d="M 55 35 L 81 23 L 115 35 L 90 49 L 55 35 M 81 23 L 90 49 M 115 35 L 132 45" />
      {[[55,35],[81,23],[115,35],[90,49],[132,45]].map(([x,y])=><circle key={x} cx={x} cy={y} r="4" />)}
    </g> : <g className={styles.records}>
      {[0,1,2].map(i=><path key={i} d={`M ${52+i*18} ${24+i*5} l 30 12 l -6 5 l -30 -12 Z`} />)}
    </g>}
  </svg>;
}

/** Presentation-only: no tool calls, external assets, or automatic data transmission. */
export default function FlowDiagram({kind='architecture'}: {kind?: FlowKind}) {
  const flow=flows[kind], id=useId();
  const [step,setStep]=useState(-1), [playing,setPlaying]=useState(false), [reduced,setReduced]=useState(false);
  useEffect(()=>{
    const query=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>{setReduced(query.matches);setPlaying(false);};
    update();query.addEventListener('change',update);
    return ()=>query.removeEventListener('change',update);
  },[]);
  useEffect(()=>{
    if(!playing || reduced) return;
    const timer=window.setTimeout(()=>{
      if(step>=flow.steps.length-1) setPlaying(false);
      else setStep(n=>n+1);
    },1200);
    return ()=>window.clearTimeout(timer);
  },[playing,step,reduced,flow.steps.length]);
  const complete=step===flow.steps.length-1 && !playing;
  const play=()=>{
    if(reduced) {setStep(n=>n>=flow.steps.length-1?-1:n+1);return;}
    if(playing) {setPlaying(false);return;}
    if(step<0 || complete) setStep(0);
    setPlaying(true);
  };
  const label=reduced?'Next stage':playing?'Pause':complete?'Replay flow':step>=0?'Resume':'Play flow';
  return <figure className={styles.figure} aria-labelledby={`${id}-title`}>
    <figcaption id={`${id}-title`} className={styles.heading}>{flow.title}</figcaption>
    <div className={styles.toolbar}>
      <button type="button" onClick={play} aria-label={`${label}: ${flow.title}`}>{label}</button>
      <span role="status" aria-live="polite">{step<0?'Local analysis · clear boundaries':`${step+1} / ${flow.steps.length} · ${flow.steps[step].title}${complete?' · ready':''}`}</span>
    </div>
    <ol className={`${styles.steps} ${flow.steps.length===4?styles.four:''}`}>
      {flow.steps.map((node,index)=><li key={node.title} className={index===step?styles.current:undefined}>
        <span className={styles.stepTitle}>{node.title}</span>
        <Plate index={index} active={index===step} />
        <span className={styles.detail}>{node.detail}</span>
        {index<flow.steps.length-1 && <span className={`${styles.arrow} ${playing && index===step && !reduced?styles.moving:''}`} aria-hidden="true"><i /></span>}
      </li>)}
    </ol>
    {kind==='storage' && <div className={styles.routes} aria-label="Alternative disk-index paths">
      <div><strong>First build</strong><span>Parse and write in bounded batches</span><span aria-hidden="true">→</span><span>Verify persisted bytes and publish atomically</span></div>
      <div><strong>Reopen</strong><span>Verify capture, version and component checksums</span><span aria-hidden="true">→</span><span>Load the existing mapped structure</span></div>
      <p>Both paths → dominators and retained results. Suitable catalog columns use lossless block encoding; Waste runs only when requested.</p>
    </div>}
    {kind==='architecture' && <>
      <svg className={styles.branch} viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true"><path d="M 500 0 V 12 H 300 V 22 M 100 22 H 500 M 100 22 V 36 M 300 22 V 36 M 500 22 V 36 M 96 32 L 100 36 L 104 32 M 296 32 L 300 36 L 304 32 M 496 32 L 500 36 L 504 32" /></svg>
      <div className={styles.hostLabel}>Present results through one host adapter</div>
      <div className={styles.hosts} aria-label="Alternative host adapters">
        {[['VS Code','installation'],['IntelliJ','intellij'],['Standalone browser','standalone']].map(([host,guide])=><Link key={host} to={`/docs/getting-started/${guide}`}>{host}<span aria-hidden="true">↗</span></Link>)}
      </div>
      <div className={styles.optional}>Optional AI: selected context → user action / approval boundary → configured provider</div>
    </>}
    <p className={styles.note}>{flow.note} Motion is illustrative, not measured timing. No analysis or network request runs here.</p>
  </figure>;
}
