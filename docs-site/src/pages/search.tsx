import React,{useEffect,useMemo,useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Heading from '@theme/Heading';
type Entry={title:string;url:string;text:string};
export default function Search() {
  const url=useBaseUrl('/search-index.json'),[query,setQuery]=useState(''),[entries,setEntries]=useState<Entry[]>([]),[status,setStatus]=useState('Loading local index…');
  useEffect(()=>{const controller=new AbortController();fetch(url,{signal:controller.signal}).then(r=>{if(!r.ok)throw new Error('index');return r.json();}).then(data=>{setEntries(data);setStatus('');}).catch(error=>{if(error.name!=='AbortError')setStatus('Search is unavailable. Use the documentation sidebar.');});return ()=>controller.abort();},[url]);
  const results=useMemo(()=>{const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);if(!terms.length)return [];
    return entries.map(entry=>({entry,score:terms.reduce((n,t)=>n+(entry.title.toLocaleLowerCase().includes(t)?4:0),0)})).filter(({entry})=>terms.every(t=>(entry.title+' '+entry.text).toLocaleLowerCase().includes(t))).sort((a,b)=>b.score-a.score).slice(0,30);
  },[entries,query]);
  return <Layout title="Search documentation" description="Search HeapLens documentation locally in your browser.">
    <main className="container margin-vert--xl" style={{maxWidth:900}}>
      <Heading as="h1">Search documentation</Heading><p>Your search stays in this browser. No search query is sent to a search service.</p>
      <label htmlFor="docs-search">Words or a command</label>
      <input id="docs-search" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Try retained size, telemetry, or HeapQL" style={{display:'block',width:'100%',padding:'.85rem',font:'inherit',margin:'.6rem 0 1.5rem',border:'1px solid var(--ifm-color-emphasis-400)',borderRadius:8,background:'var(--ifm-background-surface-color)',color:'inherit'}} />
      <p role="status" aria-live="polite">{status || (query.trim()?results.length+' matching pages'+(results.length===30?' (showing first 30)':''):'Search all guides, concepts, and references.')}</p>
      <ul style={{listStyle:'none',padding:0}}>{results.map(({entry})=><li key={entry.url} style={{borderTop:'1px solid var(--ifm-color-emphasis-200)',padding:'1.2rem 0'}}>
        <Heading as="h2" style={{fontSize:'1.2rem'}}><Link to={entry.url}>{entry.title}</Link></Heading><p style={{fontSize:'.9rem',marginBottom:0}}>{entry.text.slice(Math.max(0,entry.text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase())-70),Math.max(0,entry.text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase())-70)+240)}…</p>
      </li>)}</ul>
    </main>
  </Layout>;
}
