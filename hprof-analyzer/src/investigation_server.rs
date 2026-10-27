//! Independent bounded read jobs: cancellation never queues behind analysis or a query.
use crate::{send_stdout, AnalysisControl, FileAnalysisState, JsonRpcRequest};
use anyhow::{ensure, Result};
use hprof_analyzer::{
    indexed::HeapAnalysis,
    investigation::{Budget, Request},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
};
use tokio::sync::{Notify, Semaphore};
type States = Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>;
type Controls = Arc<RwLock<HashMap<String, AnalysisControl>>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    path: String,
    analysis_id: String,
    job_id: String,
    action: Request,
}
struct Job {
    cancelled: Arc<AtomicBool>,
    notify: Notify,
}
#[derive(Default)]
struct Registry {
    active: HashMap<String, Arc<Job>>,
    seen: HashSet<String>,
}
#[derive(Clone)]
pub(crate) struct Jobs {
    registry: Arc<Mutex<Registry>>,
    workers: Arc<Semaphore>,
}
impl Default for Jobs {
    fn default() -> Self {
        Self {
            registry: Arc::default(),
            workers: Arc::new(Semaphore::new(2)),
        }
    }
}
struct Retire {
    registry: Arc<Mutex<Registry>>,
    id: String,
}
impl Drop for Retire {
    fn drop(&mut self) {
        if let Ok(mut r) = self.registry.lock() {
            r.active.remove(&self.id);
        }
    }
}
fn error(id: &Option<Value>, message: &str) {
    if let Some(id) = id {
        let _ = send_stdout(
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32003,"message":message}}),
        );
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|v| v.is_ascii_hexdigit())
}

impl Jobs {
    fn register(&self, id: &str) -> Result<(Arc<Job>, Retire)> {
        ensure!(valid_id(id), "Invalid investigation job ID");
        let mut r = self
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("Investigation unavailable"))?;
        ensure!(r.active.len() < 8, "Investigation queue is full");
        ensure!(
            r.seen.len() < 4096,
            "Investigation session limit reached; reopen this dump"
        );
        ensure!(
            !r.seen.contains(id),
            "Investigation job IDs cannot be reused"
        );
        let job = Arc::new(Job {
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Notify::new(),
        });
        r.seen.insert(id.into());
        r.active.insert(id.into(), job.clone());
        Ok((
            job,
            Retire {
                registry: self.registry.clone(),
                id: id.into(),
            },
        ))
    }
    fn cancel(&self, id: &str) -> bool {
        let Ok(r) = self.registry.lock() else {
            return false;
        };
        if let Some(job) = r.active.get(id) {
            job.cancelled.store(true, Ordering::Relaxed);
            job.notify.notify_one();
            true
        } else {
            false
        }
    }
    pub fn handle(
        &self,
        request: JsonRpcRequest,
        states: &States,
        controls: &Controls,
        engine: Arc<tokio::sync::RwLock<()>>,
    ) {
        if request.method == "cancel_investigation" {
            let cancelled = request
                .params
                .as_ref()
                .and_then(|p| p.get("job_id"))
                .and_then(Value::as_str)
                .filter(|id| valid_id(id))
                .is_some_and(|id| self.cancel(id));
            if let Some(id) = request.id {
                let _ =
                    send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":{"cancelled":cancelled}}));
            }
            return;
        }
        let params = match request
            .params
            .clone()
            .and_then(|p| serde_json::from_value::<Params>(p).ok())
        {
            Some(p) => p,
            None => {
                error(&request.id, "Invalid bounded investigation parameters");
                return;
            }
        };
        let pinned = match pin(&params, states, controls) {
            Ok(v) => v,
            Err(_) => {
                error(
                    &request.id,
                    "Analysis unavailable or changed; retry after retained analysis",
                );
                return;
            }
        };
        if params.action.object_id().is_err() {
            error(&request.id, "Expected a positive exact decimal object ID");
            return;
        }
        let (job, retire) = match self.register(&params.job_id) {
            Ok(v) => v,
            Err(e) => {
                error(&request.id, &e.to_string());
                return;
            }
        };
        let budget = Budget::new(job.cancelled.clone());
        let workers = self.workers.clone();
        let states = states.clone();
        let controls = controls.clone();
        tokio::spawn(async move {
            let _retire = retire;
            let result = async {
                let _worker = wait(&job, &budget, workers.acquire_owned()).await??;
                let gate = wait(&job, &budget, engine.read_owned()).await?;
                ensure!(
                    current(&params, &pinned, &states, &controls),
                    "Analysis changed"
                );
                let id = params.analysis_id.clone();
                let rpc_id = request.id.clone();
                let value = tokio::task::spawn_blocking(move || -> Result<Value> {
                    let _gate = gate;
                    let mut budget = budget;
                    budget.check()?;
                    let result = pinned.investigate_metadata(&params.action, &mut budget)?;
                    budget.check()?;
                    ensure!(
                        current(&params, &pinned, &states, &controls),
                        "Analysis changed"
                    );
                    Ok(result)
                })
                .await??;
                Ok::<_, anyhow::Error>((rpc_id, json!({"analysis_id":id,"evidence":value})))
            }
            .await;
            match result {Ok((Some(id),result))=>{let _=send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":result}));},Ok(_)=>{},Err(_)=>error(&request.id,"Investigation unavailable, cancelled, changed or budget exhausted; no complete result claimed")}
        });
    }
}
fn pin(params: &Params, states: &States, controls: &Controls) -> Result<Arc<dyn HeapAnalysis>> {
    ensure!(
        controls
            .read()
            .map_err(|_| anyhow::anyhow!("Analysis unavailable"))?
            .is_empty(),
        "Analysis active"
    );
    let states = states
        .read()
        .map_err(|_| anyhow::anyhow!("Analysis unavailable"))?;
    let file = states
        .get(&PathBuf::from(&params.path))
        .ok_or_else(|| anyhow::anyhow!("Analysis unavailable"))?;
    ensure!(
        file.generation.to_string() == params.analysis_id && file.generation > 0,
        "Analysis changed"
    );
    let state = file
        .state
        .read()
        .map_err(|_| anyhow::anyhow!("Analysis unavailable"))?
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Analysis unavailable"))?;
    Ok(state)
}
fn current(
    params: &Params,
    pinned: &Arc<dyn HeapAnalysis>,
    states: &States,
    controls: &Controls,
) -> bool {
    pin(params, states, controls).is_ok_and(|live| Arc::ptr_eq(pinned, &live))
}
async fn wait<T>(job: &Job, budget: &Budget, future: impl Future<Output = T>) -> Result<T> {
    budget.check()?;
    tokio::select! {
        _=job.notify.notified()=>anyhow::bail!("Investigation cancelled"),
        value=tokio::time::timeout_at(tokio::time::Instant::from_std(budget.deadline),future)=>Ok(value?),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_while_queued_releases_admission_and_ids_never_rebind() {
        let jobs = Jobs::default();
        let id = "a".repeat(32);
        let (job, retire) = jobs.register(&id).unwrap();
        assert!(jobs.register(&id).is_err());
        let b = Budget::new(job.cancelled.clone());
        let gate = Semaphore::new(0);
        assert!(jobs.cancel(&id));
        assert!(wait(&job, &b, gate.acquire()).await.is_err());
        drop(retire);
        assert!(!jobs.cancel(&id));
        assert!(jobs.register(&id).is_err());
        assert_eq!(jobs.registry.lock().unwrap().active.len(), 0);
    }
    #[tokio::test]
    async fn deadlines_include_queue_and_registry_has_a_fixed_capacity() {
        let jobs = Jobs::default();
        let mut guards = Vec::new();
        for n in 0..8 {
            guards.push(jobs.register(&format!("{n:032x}")).unwrap());
        }
        assert!(jobs.register(&format!("{:032x}", 99)).is_err());
        let (job, _) = &guards[0];
        let mut b = Budget::new(job.cancelled.clone());
        b.deadline = std::time::Instant::now();
        assert!(wait(job, &b, Semaphore::new(0).acquire()).await.is_err());
        drop(guards);
        assert_eq!(jobs.registry.lock().unwrap().active.len(), 0);
    }
    #[tokio::test]
    async fn cancellation_wakes_both_worker_and_engine_waits_already_in_progress() {
        for engine_wait in [false, true] {
            let jobs = Jobs::default();
            let id = if engine_wait { "c" } else { "d" }.repeat(32);
            let (job, _retire) = jobs.register(&id).unwrap();
            let budget = Budget::new(job.cancelled.clone());
            let workers = Arc::new(Semaphore::new(0));
            let engine = Arc::new(tokio::sync::RwLock::new(()));
            let held = engine.clone().write_owned().await;
            let task = tokio::spawn(async move {
                if engine_wait {
                    wait(&job, &budget, engine.read_owned()).await.map(|_| ())
                } else {
                    wait(&job, &budget, workers.acquire_owned())
                        .await
                        .map(|_| ())
                }
            });
            tokio::task::yield_now().await;
            assert!(jobs.cancel(&id));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(250), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            drop(held);
        }
    }
}
