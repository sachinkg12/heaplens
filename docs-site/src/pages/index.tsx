import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import FlowDiagram from '@site/src/components/FlowDiagram';
import styles from './index.module.css';

const paths=[
  {label:'01 / Orient',title:'Understand the snapshot',text:'Start with totals, then separate shallow storage from retained ownership.',to:'/docs/tabs-guide/overview-tab'},
  {label:'02 / Investigate',title:'Follow the evidence',text:'Explore dominators, actual references, object fields, and paths to GC roots.',to:'/docs/concepts/dominator-tree'},
  {label:'03 / Ask',title:'Query precisely',text:'Use HeapQL filters, aggregates, joins, and supported subqueries.',to:'/docs/api-reference/heapql'},
  {label:'04 / Review',title:'Bridge to code',text:'Resolve source through your host. AI suggestions remain proposals to inspect and test.',to:'/docs/tabs-guide/source-tab'},
];
export default function Home() {
  return <Layout title="From heap snapshot to code investigation" description="HeapLens documentation: local Java heap analysis, HeapQL, source navigation, optional AI, and host-specific setup.">
    <main className={styles.main}>
      <header className={styles.hero}>
        <div className={styles.eyebrow}><span aria-hidden="true" /> OPEN SOURCE / LOCAL HEAP ANALYSIS</div>
        <Heading as="h1">Find what keeps<br />memory <span>alive.</span></Heading>
        <p className={styles.intro}>Turn a Java heap snapshot into an investigation. Explore retained memory, trace references, query objects, and review the code—without treating a suspect as a verdict.</p>
        <div className={styles.actions}>
          <Link className="button button--primary button--lg" to="/docs/getting-started/installation">Install for VS Code</Link>
          <Link className="button button--secondary button--lg" to="/docs/getting-started/choose-host">Choose your host →</Link>
        </div>
        <p className={styles.release}>VS Code: released · IntelliJ and standalone packages: preview guides<br />Availability depends on the published package, platform, and version.</p>
      </header>
      <section className={styles.flow} aria-label="HeapLens data flow"><FlowDiagram /></section>
      <section className={styles.strip} aria-label="Implemented capabilities">
        <div><strong>11</strong><span>analysis & workflow tabs</span></div>
        <div><strong>10</strong><span>configured AI providers</span></div>
        <div><strong>9</strong><span>MCP tools</span></div>
        <div><strong>Apache 2.0</strong><span>open-source license</span></div>
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHead}><div className={styles.eyebrow}>A SMALLER PATH TO CLARITY</div><Heading as="h2">Start with evidence.<br />Keep the boundaries visible.</Heading></div>
        <div className={styles.grid}>{paths.map(item=><Link key={item.label} to={item.to} className={styles.card}>
          <span className={styles.cardLabel}>{item.label}</span><Heading as="h3">{item.title}</Heading><p>{item.text}</p><span aria-hidden="true" className={styles.cardArrow}>↗</span>
        </Link>)}</div>
      </section>
      <section className={styles.boundaries}>
        <div><div className={styles.eyebrow}>YOUR DATA / YOUR DECISION</div><Heading as="h2">Local analysis.<br />Optional AI. Explicit limits.</Heading><p>The analysis engine reads your local dump. AI actions and telemetry have separate controls. Metadata can still be sensitive; approved AI fixes send the full source file.</p></div>
        <div className={styles.links}><Link to="/docs/ai-integration/privacy">What AI receives →</Link><Link to="/docs/runbook/telemetry">Telemetry and opt-out →</Link><Link to="/docs/runbook/performance-tuning">Memory limits and large heaps →</Link></div>
      </section>
      <section className={styles.bottom}><Heading as="h2">One engine. Different environments.</Heading><p>VS Code, IntelliJ, terminal, browser, and MCP adapters reuse analysis—not every host capability. Setup and limitations are documented separately.</p><Link to="/docs/getting-started/choose-host">Explore the host guide →</Link></section>
    </main>
  </Layout>;
}
