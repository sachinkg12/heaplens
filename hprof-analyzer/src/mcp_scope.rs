//! Stdio MCP metadata boundary. Launch configuration is authority; tool arguments are not.
use anyhow::{ensure,Result};
use hprof_analyzer::{indexed::{HeapAnalysis,IndexedAnalysisState,storage::{StorageOptions,load_structure}},investigation::{Budget,Request}};
use serde::Deserialize;
use serde_json::{json,Value};
use std::{collections::{HashMap,HashSet},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,SystemTime}};
use tokio::{io::{AsyncBufReadExt,BufReader},sync::{Notify,Mutex as AsyncMutex}};
const MAX_FRAME:usize=65536;
#[derive(Clone,PartialEq)] struct Stamp {length:u64,modified:Option<SystemTime>,created:Option<SystemTime>,file:u64,device:u64}
fn stamp(path:&Path)->Result<Stamp>{
    let m=std::fs::symlink_metadata(path)?;ensure!(m.is_file() && !m.file_type().is_symlink(),"Approved dump unavailable");
    Ok(metadata_stamp(&m))
}
fn metadata_stamp(m:&std::fs::Metadata)->Stamp {
    #[cfg(unix)] let (file,device)={use std::os::unix::fs::MetadataExt;(m.ino(),m.dev())};
    #[cfg(not(unix))] let (file,device)=(0,0);
    Stamp{length:m.len(),modified:m.modified().ok(),created:m.created().ok(),file,device}
}
struct Allowed {id:String,path:PathBuf,stamp:Stamp}
fn verify_handle(file:&Allowed,input:&std::fs::File)->Result<()>{ensure!(metadata_stamp(&input.metadata()?)==file.stamp,"Approved handle changed");Ok(())}
struct Saved {generation:String,state:Arc<dyn HeapAnalysis>,records:HashMap<String,Value>}
struct Scope {allowed:Vec<Allowed>,share:bool,states:Mutex<HashMap<String,Saved>>,sequence:AtomicU64}
impl Scope {
    fn new(files:Vec<PathBuf>,share:bool)->Result<Self>{
        ensure!(files.len()<=8,"At most eight exact MCP files may be approved");let mut allowed=Vec::new();let mut seen=HashSet::new();
        for original in files {ensure!(original.is_absolute(),"MCP requires absolute approved file paths");stamp(&original)?;let path=std::fs::canonicalize(&original)?;
            ensure!(seen.insert(path.clone()),"Duplicate MCP file approval");let value=stamp(&path)?;allowed.push(Allowed{id:format!("dump_{}",allowed.len()+1),path,stamp:value});}
        Ok(Self{allowed,share,states:Mutex::new(HashMap::new()),sequence:AtomicU64::new(0)})
    }
    fn allowed(&self,id:&str)->Result<&Allowed>{ensure!(self.share,"Metadata sharing requires launch-time approval");let file=self.allowed.iter().find(|f|f.id==id).ok_or_else(||anyhow::anyhow!("Dump not approved"))?;
        ensure!(stamp(&file.path)?==file.stamp,"Approved dump changed; restart with fresh human approval");Ok(file)}
    fn record(&self,id:&str,generation:&str,operation:&str,evidence:Value)->Result<Value>{
        ensure!(serde_json::to_vec(&evidence)?.len()<=65536,"Evidence limit");self.allowed(id)?;
        let mut states=self.states.lock().map_err(|_|anyhow::anyhow!("Scope unavailable"))?;let saved=states.get_mut(id).ok_or_else(||anyhow::anyhow!("Analysis unavailable"))?;
        ensure!(saved.generation==generation && saved.records.len()<32,"Evidence scope changed or session limit reached");
        let record=json!({"id":format!("E{}_{}",generation,saved.records.len()+1),"scope":generation,"operation":operation,"data":evidence});
        saved.records.insert(record["id"].as_str().unwrap().into(),record.clone());Ok(record)
    }
    fn state(&self,id:&str,generation:&str)->Result<Arc<dyn HeapAnalysis>>{
        self.allowed(id)?;let states=self.states.lock().map_err(|_|anyhow::anyhow!("Scope unavailable"))?;let s=states.get(id).ok_or_else(||anyhow::anyhow!("Analyze the approved dump first"))?;
        ensure!(s.generation==generation,"Analysis generation changed");Ok(s.state.clone())
    }
}
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Call {name:String,#[serde(default)]arguments:Value,#[serde(rename="_meta")]_meta:Option<Value>}
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Dump {dump_id:String}
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Read {dump_id:String,analysis_id:String,action:Request}
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Current {dump_id:String,analysis_id:String}
#[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Evidence {dump_id:String,analysis_id:String,evidence_id:String}
struct Job {cancel:Arc<AtomicBool>,requested:AtomicBool,notify:Notify}
#[derive(Default)]struct Registry {active:HashMap<String,Arc<Job>>,seen:HashSet<String>}
struct Retire {registry:Arc<Mutex<Registry>>,id:String}
impl Drop for Retire {fn drop(&mut self){if let Ok(mut r)=self.registry.lock(){r.active.remove(&self.id);}}}
fn result(value:Value)->Value{json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})}
fn failure()->Value{json!({"content":[{"type":"text","text":"MCP request rejected, cancelled, changed or over budget. Use launch-time exact-file approval and --mcp-share-metadata; no raw-value or unrestricted fallback is available."}],"isError":true})}
fn tools()->Value{
    let string=json!({"type":"string"});let fields=|values:Vec<(&str,Value)>|{let required:Vec<_>=values.iter().map(|(k,_)|*k).collect();let props:serde_json::Map<_,_>=values.iter().map(|(k,v)|(k.to_string(),v.clone())).collect();json!({"type":"object","properties":props,"required":required,"additionalProperties":false})};
    let defs=[("list_dumps",fields(vec![]),true),("analyze_heap",fields(vec![("dump_id",string.clone())]),false),
        ("get_summary",fields(vec![("dump_id",string.clone()),("analysis_id",string.clone())]),true),
        ("investigate_heap",fields(vec![("dump_id",string.clone()),("analysis_id",string.clone()),("action",fields(vec![("operation",json!({"type":"string","enum":["object","fields","outbound","referrers","children","root_path"]})),("object_id",string.clone())]))]),true),
        ("get_evidence",fields(vec![("dump_id",string.clone()),("analysis_id",string.clone()),("evidence_id",string.clone())]),true),
        ("close_dump",fields(vec![("dump_id",string.clone()),("analysis_id",string)]),false)];
    json!({"tools":defs.into_iter().map(|(name,input,read)|json!({"name":name,"description":"Explicitly approved, generation-scoped heap metadata only. Values are engine evidence, not a proven leak. Names can be sensitive. No arbitrary query, file or raw contents.","inputSchema":input,"annotations":{"readOnlyHint":read,"destructiveHint":false,"openWorldHint":false}})).collect::<Vec<_>>()})
}
fn summary(state:&dyn HeapAnalysis)->Value {
    let s=state.get_summary();let rows:Vec<_>=state.get_top_layers(1,15).iter().map(|o|json!({"object_id":o.object_id.to_string(),"class_name":hprof_analyzer::investigation::name(&o.class_name),"name_truncated":o.class_name.chars().nth(256).is_some(),"shallow_size":o.shallow_size.to_string(),"retained_size":o.retained_size.to_string(),"node_type":o.node_type})).collect();
    json!({"summary":{"total_heap_size":s.total_heap_size.to_string(),"reachable_heap_size":s.reachable_heap_size.to_string(),"total_instances":s.total_instances.to_string(),"total_classes":s.total_classes.to_string(),"total_arrays":s.total_arrays.to_string(),"total_gc_roots":s.total_gc_roots.to_string()},"rows":rows,"status":"complete","sample_limit":15,"note":"Bounded existing analysis metadata. JVM size estimates and reference policy apply. Retained sets overlap; snapshot size is not growth or proof of a leak. No raw values or source are shared."})
}
fn execute(scope:&Scope,call:Call,cancel:&Arc<AtomicBool>,options:&StorageOptions,deadline:std::time::Instant)->Result<Value>{
    ensure!(scope.share && !cancel.load(Ordering::Relaxed),"Metadata approval required");
    match call.name.as_str(){
        "list_dumps"=>{ensure!(call.arguments.is_object() && call.arguments.as_object().unwrap().is_empty(),"Unexpected arguments");Ok(json!({"dumps":scope.allowed.iter().map(|f|json!({"dump_id":f.id})).collect::<Vec<_>>(),"privacy":"Only these launch-approved aliases are accessible. Metadata can contain sensitive names; the connected client may forward it."}))},
        "analyze_heap"=>{let p:Dump=serde_json::from_value(call.arguments)?;let file=scope.allowed(&p.dump_id)?;scope.states.lock().unwrap().clear();
            let input=std::fs::File::open(&file.path)?;
            verify_handle(file,&input)?;
            // Same read-only mapping contract as ordinary analysis; approved dumps must remain immutable.
            let mapping=unsafe{memmap2::MmapOptions::new().map(&input)?};let mapping=Arc::new(mapping);
            let (one,two,report)=load_structure(mapping,options,cancel)?;ensure!(!cancel.load(Ordering::Relaxed),"Cancelled");
            let state:Arc<dyn HeapAnalysis>=Arc::new(IndexedAnalysisState::from_phases_cancellable(one,two,&||cancel.load(Ordering::Relaxed))?.with_storage_report(report));
            scope.allowed(&p.dump_id)?;verify_handle(file,&input)?;ensure!(!cancel.load(Ordering::Relaxed),"Cancelled");let generation=format!("A{}",scope.sequence.fetch_add(1,Ordering::Relaxed)+1);
            let data=summary(&*state);scope.states.lock().unwrap().insert(p.dump_id.clone(),Saved{generation:generation.clone(),state,records:HashMap::new()});
            let record=scope.record(&p.dump_id,&generation,"summary",data)?;Ok(json!({"dump_id":p.dump_id,"analysis_id":generation,"evidence":record}))},
        "get_summary"=>{let p:Current=serde_json::from_value(call.arguments)?;let state=scope.state(&p.dump_id,&p.analysis_id)?;let record=scope.record(&p.dump_id,&p.analysis_id,"summary",summary(&*state))?;Ok(json!({"dump_id":p.dump_id,"analysis_id":p.analysis_id,"evidence":record}))},
        "investigate_heap"=>{let p:Read=serde_json::from_value(call.arguments)?;p.action.object_id()?;let state=scope.state(&p.dump_id,&p.analysis_id)?;
            let mut budget=Budget::new(cancel.clone());budget.deadline=deadline;let data=state.investigate_metadata(&p.action,&mut budget)?;budget.check()?;
            let record=scope.record(&p.dump_id,&p.analysis_id,"metadata",data)?;Ok(json!({"dump_id":p.dump_id,"analysis_id":p.analysis_id,"evidence":record}))},
        "get_evidence"=>{let p:Evidence=serde_json::from_value(call.arguments)?;scope.state(&p.dump_id,&p.analysis_id)?;let states=scope.states.lock().unwrap();let value=states[&p.dump_id].records.get(&p.evidence_id).ok_or_else(||anyhow::anyhow!("Unknown evidence"))?;Ok(value.clone())},
        "close_dump"=>{let p:Current=serde_json::from_value(call.arguments)?;scope.state(&p.dump_id,&p.analysis_id)?;scope.states.lock().unwrap().remove(&p.dump_id);Ok(json!({"closed":true}))},
        _=>anyhow::bail!("Tool not permitted"),
    }
}
pub async fn run(files:Vec<PathBuf>,share:bool,options:StorageOptions)->Result<()> {
    let scope=Arc::new(Scope::new(files,share).map_err(|_|anyhow::anyhow!("Invalid MCP launch approval; use existing absolute regular files"))?);
    let registry=Arc::new(Mutex::new(Registry::default()));let gate=Arc::new(AsyncMutex::new(()));let mut input=BufReader::new(tokio::io::stdin());
    loop{
        let mut line=Vec::new();
        // Read at most one bounded frame; do not allocate an unbounded stdin line or echo it.
        let mut ended=false;
        while !ended{let bytes=input.fill_buf().await?;if bytes.is_empty(){break;}let n=bytes.iter().position(|b|*b==b'\n').map_or(bytes.len(),|i|i+1);ensure!(line.len()+n<=MAX_FRAME,"MCP input frame exceeds its limit");line.extend_from_slice(&bytes[..n]);ended=bytes[n-1]==b'\n';input.consume(n);}
        if line.is_empty(){break;}let request:Value=match serde_json::from_slice(&line){Ok(v)=>v,Err(_)=>{continue;}};
        let method=request["method"].as_str().unwrap_or("");let id=request.get("id").cloned();
        if method=="notifications/cancelled"{if let Some(cancelled)=request["params"].get("requestId"){if let Some(job)=registry.lock().unwrap().active.get(&cancelled.to_string()){job.requested.store(true,Ordering::Relaxed);job.cancel.store(true,Ordering::Relaxed);job.notify.notify_one();}}continue;}
        if method=="notifications/initialized" || method=="initialized"{continue;}
        let Some(id)=id else{continue;};if !(id.is_string() && id.as_str().unwrap().len()<=80 || id.is_u64()){continue;}
        if method=="initialize"{let offered=request["params"]["protocolVersion"].as_str().unwrap_or("");let version=if ["2024-11-05","2025-06-18","2025-11-25"].contains(&offered){offered}else{"2025-11-25"};crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"heaplens","version":env!("CARGO_PKG_VERSION")}}}))?;continue;}
        if method=="tools/list"{crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":tools()}))?;continue;}
        if method=="ping"{crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":{}}))?;continue;}
        if method!="tools/call"{crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not available"}}))?;continue;}
        let call=serde_json::from_value::<Call>(request["params"].clone());let key=id.to_string();
        let Ok(call)=call else{crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":failure()}))?;continue;};
        let job={let mut r=registry.lock().unwrap();if r.active.len()>=8 || r.seen.len()>=4096 || !r.seen.insert(key.clone()){None}else{let j=Arc::new(Job{cancel:Arc::new(AtomicBool::new(false)),requested:AtomicBool::new(false),notify:Notify::new()});r.active.insert(key.clone(),j.clone());Some(j)}};
        let Some(job)=job else{crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":failure()}))?;continue;};
        let max=if call.name=="analyze_heap"{Duration::from_secs(1800)}else{Duration::from_secs(2)};let due=std::time::Instant::now()+max;
        let retire=Retire{registry:registry.clone(),id:key};let gate=gate.clone();let scope=scope.clone();let options=options.clone();
        tokio::spawn(async move{
            let _retire=retire;
            let acquired=tokio::select!{_=job.notify.notified()=>None,value=tokio::time::timeout_at(tokio::time::Instant::from_std(due),gate.lock_owned())=>value.ok()};
            let Some(held)=acquired else{if !job.cancel.load(Ordering::Relaxed){let _=crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":failure()}));}return;};
            let cancelled=job.cancel.clone();let flag=cancelled.clone();let deadline=tokio::spawn(async move{tokio::time::sleep_until(tokio::time::Instant::from_std(due)).await;flag.store(true,Ordering::Relaxed);});
            let outcome=tokio::task::spawn_blocking(move||{let _held=held;execute(&scope,call,&cancelled,&options,due)}).await;deadline.abort();
            if job.requested.load(Ordering::Relaxed){return;}
            let value=match outcome{Ok(Ok(data)) if !job.cancel.load(Ordering::Relaxed) && std::time::Instant::now()<due=>result(data),_=>failure()};if serde_json::to_vec(&value).is_ok_and(|b|b.len()<=256*1024){let _=crate::send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":value}));}
        });
    }
    for job in registry.lock().unwrap().active.values(){job.cancel.store(true,Ordering::Relaxed);job.notify.notify_one();}
    Ok(())
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn path_swap_cannot_substitute_a_different_open_handle(){let dir=tempfile::tempdir().unwrap();let path=dir.path().join("approved");let replacement=dir.path().join("replacement");std::fs::write(&path,b"approved").unwrap();std::fs::write(&replacement,b"different bytes").unwrap();let scope=Scope::new(vec![path.clone()],true).unwrap();let file=scope.allowed("dump_1").unwrap();
        let original=dir.path().join("original");std::fs::rename(&path,&original).unwrap();std::fs::rename(&replacement,&path).unwrap();let handle=std::fs::File::open(&path).unwrap();std::fs::rename(&path,&replacement).unwrap();std::fs::rename(&original,&path).unwrap();assert!(scope.allowed("dump_1").is_ok());assert!(verify_handle(file,&handle).is_err());}
}
