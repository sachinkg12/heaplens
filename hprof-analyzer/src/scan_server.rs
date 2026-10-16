//! JSON-RPC adapter for shallow scanning. It never installs a HeapAnalysis state.
use crate::{send_stdout, AnalysisControl, FileAnalysisState, JsonRpcRequest};
use anyhow::Result;
use hprof_analyzer::quick_scan::{scan_shallow_cancellable, ScanError, ScanLimits};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, RwLock,
    },
};

pub(crate) type Controls = Arc<RwLock<HashMap<String, AnalysisControl>>>;
#[derive(Clone, Default)]
pub(crate) struct Readiness(Arc<RwLock<HashSet<PathBuf>>>);
impl Readiness {
    pub fn scan(&self, path: &str) {
        self.0.write().unwrap().insert(PathBuf::from(path));
    }
    pub fn full(&self, path: &str) {
        self.0.write().unwrap().remove(&PathBuf::from(path));
    }
    pub fn reject_read(&self, request: &JsonRpcRequest) -> Result<bool> {
        if matches!(
            request.method.as_str(),
            "scan_heap" | "analyze_heap" | "cancel_analysis" | "ping" | "compare_snapshots"
        ) {
            return Ok(false);
        }
        let Some(p) = &request.params else {
            return Ok(false);
        };
        let blocked = self
            .0
            .read()
            .map_err(|_| anyhow::anyhow!("Analysis registry unavailable"))?;
        let paths = ["path", "current_path", "baseline_path"]
            .into_iter()
            .filter_map(|k| p.get(k).and_then(|v| v.as_str()))
            .chain(
                p.get("paths")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str()),
            );
        if paths
            .into_iter()
            .any(|s| blocked.contains(&PathBuf::from(s)))
        {
            if let Some(id) = &request.id {
                send_stdout(
                    &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Retained analysis not calculated. Explicitly run analyze_heap before this operation."}}),
                )?;
            }
            return Ok(true);
        }
        Ok(false)
    }
}

/// Reject overlapping work rather than replacing its cancellation owner. Both
/// analysis modes use this guard; terminal cleanup is request-ID scoped.
pub(crate) fn claim(
    controls: &Controls,
    path: &str,
    id: u64,
    token: Arc<AtomicBool>,
) -> Result<bool> {
    let mut controls = controls
        .write()
        .map_err(|_| anyhow::anyhow!("Analysis registry unavailable"))?;
    if controls.contains_key(path) {
        send_stdout(
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32001,"message":"Analysis already active. Cancel and wait for completion, then retry."}}),
        )?;
        return Ok(false);
    }
    controls.insert(
        path.into(),
        AnalysisControl {
            request_id: id,
            cancel_token: token,
        },
    );
    Ok(true)
}
pub(crate) fn release(controls: &Controls, path: &str, id: u64) {
    if let Ok(mut entries) = controls.write() {
        if entries.get(path).is_some_and(|v| v.request_id == id) {
            entries.remove(path);
        }
    }
}

pub(crate) fn start(
    request: JsonRpcRequest,
    counter: &Arc<AtomicU64>,
    states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    controls: &Controls,
    readiness: &Readiness,
    engine_gate: Arc<tokio::sync::RwLock<()>>,
) -> Result<()> {
    let id = request
        .id
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| counter.fetch_add(1, Ordering::Relaxed));
    let Some(path) = request
        .params
        .as_ref()
        .and_then(|p| p.get("path"))
        .and_then(|p| p.as_str())
        .filter(|p| !p.is_empty())
    else {
        return send_stdout(
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"A local dump path is required"}}),
        );
    };
    let path = path.to_owned();
    let token = Arc::new(AtomicBool::new(false));
    if !claim(controls, &path, id, token.clone())? {
        return Ok(());
    }
    readiness.scan(&path);
    // A scan is a new snapshot, not permission to query a previously analyzed dump.
    states
        .write()
        .map_err(|_| anyhow::anyhow!("Analysis registry unavailable"))?
        .remove(&PathBuf::from(&path));
    send_stdout(
        &json!({"jsonrpc":"2.0","id":id,"result":{"request_id":id,"status":"processing","analysis_scope":"shallow"}}),
    )?;
    let controls = controls.clone();
    tokio::task::spawn_blocking(move || {
        let _engine = engine_gate.blocking_write();
        let progress = json!({"jsonrpc":"2.0","method":"heap_scan_progress","params":{"request_id":id,"stage":"quick_scan","phase":1,"total_phases":1}});
        let _ = send_stdout(&progress);
        // Fail closed on malformed data. Do not forward parser bytes or local paths.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let file = std::fs::File::open(&path).map_err(|_|"Could not open local heap dump")?;
            let map = unsafe { memmap2::Mmap::map(&file) }.map_err(|_|"Could not map local heap dump")?;
            scan_shallow_cancellable(&map, None, ScanLimits::default(), &||token.load(Ordering::Relaxed)).map_err(|e|match e {
                ScanError::Cancelled => "cancelled",
                ScanError::Unsupported => "Quick scan supports conventional HPROF 1.0.1 and 1.0.2. Use full analysis for other supported formats.",
                ScanError::MetadataLimit => "Quick-scan metadata limit exceeded. No retained analysis was started.",
                _ => "Malformed or incomplete heap dump",
            })
        })).unwrap_or(Err("Quick scan failed"));
        let cancelled = token.load(Ordering::Relaxed);
        let params = if cancelled {
            json!({"request_id":id,"status":"cancelled","analysis_scope":"shallow"})
        } else {
            match result {
                Ok(scan) => json!({"request_id":id,"status":"completed","analysis_scope":"shallow",
                "counts_scope":"allocation_records_and_declared_class_ids", "summary":scan.summary,"class_histogram":scan.class_histogram,
                "readiness":{"summary":"ready","shallow_histogram":"ready","reachability":"not_calculated","retained":"not_calculated","references":"not_calculated","waste":"not_calculated"}}),
                Err(error) => {
                    json!({"request_id":id,"status":"error","analysis_scope":"shallow","error":error})
                }
            }
        };
        release(&controls, &path, id);
        let _ =
            send_stdout(&json!({"jsonrpc":"2.0","method":"heap_scan_complete","params":params}));
    });
    Ok(())
}
