//! Bounded post-analysis work. Control requests never wait behind CPU queries.
use crate::{AnalysisControl, FileAnalysisState, JsonRpcRequest, send_stdout};
use anyhow::{ensure, Result};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::{Arc, RwLock}};
use tokio::sync::Semaphore;

type States = Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>;

#[derive(Clone)]
pub(crate) struct ReadJobs {
    workers: Arc<Semaphore>,
    slots: Arc<Semaphore>,
    // Full scans can allocate query scratch; do not run several simultaneously.
    scans: Arc<Semaphore>,
    engine: Arc<tokio::sync::RwLock<()>>,
}
impl Default for ReadJobs {
    fn default() -> Self {
        let cpus=std::thread::available_parallelism().map(usize::from).unwrap_or(1);
        let workers=(cpus / 2).clamp(1,3);
        Self {workers:Arc::new(Semaphore::new(workers)), slots:Arc::new(Semaphore::new(workers+8)), scans:Arc::new(Semaphore::new(1)), engine:Arc::new(tokio::sync::RwLock::new(()))}
    }
}

pub(crate) fn handles(method: &str) -> bool {
    matches!(method,"get_children"|"get_referrers"|"get_waste_analysis"|"export_json"|
        "gc_root_path"|"inspect_object"|"execute_query"|"compare_heaps"|"compare_snapshots"|
        "get_dominator_subtree"|"get_timeline_data")
}
fn full_scan(method: &str) -> bool {
    !matches!(method,"get_children"|"get_referrers"|"get_dominator_subtree")
}
fn paths(request: &JsonRpcRequest) -> Result<Vec<PathBuf>> {
    let p=request.params.as_ref().ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    if request.method=="compare_snapshots" {return Ok(Vec::new());}
    if request.method=="get_timeline_data" {
        let values=p.get("paths").and_then(|v|v.as_array()).ok_or_else(||anyhow::anyhow!("Missing paths"))?;
        ensure!(values.len()<=64,"At most 64 timeline snapshots per request");
        return values.iter().map(|v|v.as_str().map(PathBuf::from).ok_or_else(||anyhow::anyhow!("Invalid path"))).collect();
    }
    let keys: &[&str]=if request.method=="compare_heaps" {&["current_path","baseline_path"]} else {&["path"]};
    keys.iter().map(|key|p.get(key).and_then(|v|v.as_str()).map(PathBuf::from).ok_or_else(||anyhow::anyhow!("Missing path"))).collect()
}

// Pin only requested immutable states. No graph copies and no global registry
// lock held during work, waiting, serialization, or output.
fn pin(request: &JsonRpcRequest, live: &States, active: &Arc<RwLock<HashMap<String, AnalysisControl>>>) -> Result<States> {
    let requested=paths(request)?;
    let active=active.read().map_err(|_|anyhow::anyhow!("Analysis registry unavailable"))?;
    // Analysis already uses a parallel engine pool. Avoid adding scan workers
    // on top of it in this process; callers can retry after completion.
    ensure!(active.is_empty(),"Analysis is running. Retry this read after completion.");
    let live=live.read().map_err(|_|anyhow::anyhow!("Analysis registry unavailable"))?;
    let mut pinned=HashMap::new();
    for path in requested {
        let Some(file)=live.get(&path) else {
            if request.method=="get_timeline_data" {continue;}
            anyhow::bail!("Complete retained analysis before this request");
        };
        let state=file.state.read().map_err(|_|anyhow::anyhow!("Analysis unavailable"))?.clone()
            .ok_or_else(||anyhow::anyhow!("Complete retained analysis before this request"))?;
        let mut snapshot=file.clone();
        snapshot.state=Arc::new(RwLock::new(Some(state)));
        pinned.insert(path,snapshot);
    }
    Ok(Arc::new(RwLock::new(pinned)))
}
fn still_current(pinned: &States, live: &States, active: &Arc<RwLock<HashMap<String, AnalysisControl>>>) -> bool {
    let Ok(active)=active.read() else {return false;};
    if !active.is_empty() {return false;}
    let (Ok(pinned),Ok(live))=(pinned.read(),live.read()) else {return false;};
    pinned.iter().all(|(path,old)|live.get(path).is_some_and(|new| {
        let (Ok(old),Ok(new))=(old.state.read(),new.state.read()) else {return false;};
        match (old.as_ref(),new.as_ref()) {(Some(a),Some(b))=>Arc::ptr_eq(a,b),_=>false}
    }))
}
fn error(id: &Option<serde_json::Value>, code:i32, message:&str) {
    if let Some(id)=id {let _=send_stdout(&json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}));}
}
impl ReadJobs {
    pub fn engine_gate(&self) -> Arc<tokio::sync::RwLock<()>> { self.engine.clone() }
    pub fn start(&self, request: JsonRpcRequest, live: &States, active: &Arc<RwLock<HashMap<String, AnalysisControl>>>) {
        let Ok(slot)=self.slots.clone().try_acquire_owned() else {
            error(&request.id,-32001,"Read queue is full. Retry shortly.");return;
        };
        let pinned=match pin(&request,live,active) {
            Ok(value)=>value,Err(e)=>{error(&request.id,-32002,&e.to_string());return;}
        };
        let jobs=self.clone();let live=live.clone();let active=active.clone();
        tokio::spawn(async move {
            // Acquire expensive-scan budget before a worker so queued scans do
            // not occupy all workers and block small interactive reads.
            let _scan=if full_scan(&request.method) {Some(jobs.scans.acquire_owned().await.expect("open scan budget"))}else{None};
            let worker=jobs.workers.acquire_owned().await.expect("open read budget");
            let engine=jobs.engine.read_owned().await;
            let runtime=tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                let (_slot,_worker,_scan,_engine)=(slot,worker,_scan,engine);
                if !still_current(&pinned,&live,&active) {error(&request.id,-32002,"Analysis changed while this request was queued. Retry.");return;}
                let id=request.id.clone();
                let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||runtime.block_on(dispatch(request,&pinned))));
                match result {Ok(Ok(()))=>{},Ok(Err(_))=>error(&id,-32602,"Analysis request failed. Check its parameters and retry."),Err(_)=>error(&id,-32000,"Analysis request failed. Retry or reopen the dump.")}
            }).await.ok();
        });
    }
}

async fn dispatch(request:JsonRpcRequest, states:&States)->Result<()> {
    match request.method.as_str() {
        "get_children"=>crate::handle_get_children_request(request,states).await,
        "get_referrers"=>crate::handle_get_referrers_request(request,states).await,
        "get_waste_analysis"=>crate::waste_server::start(request,states),
        "export_json"=>crate::handle_export_json_request(request,states).await,
        "gc_root_path"=>crate::handle_gc_root_path_request(request,states).await,
        "inspect_object"=>crate::handle_inspect_object_request(request,states).await,
        "execute_query"=>crate::handle_execute_query_request(request,states).await,
        "compare_heaps"=>crate::handle_compare_heaps_request(request,states).await,
        "get_dominator_subtree"=>crate::handle_get_dominator_subtree_request(request,states).await,
        "get_timeline_data"=>crate::handle_get_timeline_data_request(request,states).await,
        "compare_snapshots"=>{
            if let Some(id)=request.id {
                let response=match hprof_analyzer::comparison::compare_snapshot_request(request.params.unwrap_or(serde_json::Value::Null)) {
                    Ok(result)=>json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(message)=>json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":message}}),
                };send_stdout(&response)?;
            } Ok(())
        },
        _=>unreachable!("read method classified before dispatch"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_plane_is_never_scheduled_behind_reads() {
        for m in ["ping","cancel_analysis","analyze_heap","scan_heap"] {assert!(!handles(m));}
        assert!(handles("execute_query"));assert!(handles("get_waste_analysis"));
        let jobs=ReadJobs::default();let workers=jobs.workers.available_permits();
        assert!((1..=3).contains(&workers));assert_eq!(jobs.slots.available_permits(),workers+8);
        let _scan=jobs.scans.try_acquire().unwrap();assert!(jobs.scans.try_acquire().is_err());
    }
    #[tokio::test]
    async fn budgets_reject_overflow_release_permits_and_exclude_engine_work() {
        let jobs=ReadJobs::default();
        let slots=jobs.slots.available_permits();
        let mut admitted=Vec::new();
        for _ in 0..slots {admitted.push(jobs.slots.clone().try_acquire_owned().unwrap());}
        assert!(jobs.slots.clone().try_acquire_owned().is_err());
        drop(admitted);assert_eq!(jobs.slots.available_permits(),slots);
        let engine=jobs.engine.write().await;
        assert!(jobs.engine.try_read().is_err());
        drop(engine);
        let read=jobs.engine.read().await;
        assert!(jobs.engine.try_write().is_err());
        drop(read);assert!(jobs.engine.try_write().is_ok());
        let live=Arc::new(RwLock::new(HashMap::new()));
        let active=Arc::new(RwLock::new(HashMap::new()));
        let request=JsonRpcRequest {jsonrpc:"2.0".into(),id:Some(json!(1)),method:"compare_snapshots".into(),params:Some(json!({}))};
        let pinned=pin(&request,&live,&active).unwrap();assert!(still_current(&pinned,&live,&active));
        active.write().unwrap().insert("dump".into(),AnalysisControl {request_id:2,cancel_token:Arc::new(std::sync::atomic::AtomicBool::new(false))});
        assert!(pin(&request,&live,&active).is_err());assert!(!still_current(&pinned,&live,&active));
    }
}
