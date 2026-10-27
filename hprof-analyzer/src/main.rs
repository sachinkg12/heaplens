//! Async JSON-RPC server and MCP server for HPROF analysis
//!
//! This server reads JSON-RPC requests from stdin and processes CPU-intensive
//! heap analysis tasks asynchronously using tokio blocking tasks.
//!
//! When run with `--mcp`, it operates as an MCP (Model Context Protocol) server
//! for use with AI clients like Claude Desktop.

use anyhow::{Context, Result};
mod scan_server;
mod waste_server;
mod read_jobs;
mod investigation_server;
mod mcp_scope;
use clap::Parser;
use hprof_analyzer::{build_graph, calculate_dominators_with_state, compare_heaps, HprofLoader, WasteAnalysis};
use hprof_analyzer::indexed::types::HeapAnalysis;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Global flag: use the indexed (CSR-based) analysis backend.
static USE_INDEXED: AtomicBool = AtomicBool::new(false);
static STORAGE: std::sync::OnceLock<hprof_analyzer::indexed::storage::StorageOptions> = std::sync::OnceLock::new();
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::signal;
use tokio::sync::mpsc;
use tokio::task;

/// CLI arguments for hprof-server.
#[derive(Parser)]
#[command(name = "hprof-server", about = "HPROF heap dump analysis server")]
struct Cli {
    /// Run as an MCP (Model Context Protocol) server instead of JSON-RPC
    #[arg(long)]
    mcp: bool,
    /// Exact existing files approved by the launching user for this MCP process (repeatable).
    #[arg(long)]
    mcp_allow_file: Vec<PathBuf>,
    /// Explicit permission to disclose metadata to the connected MCP client; not raw heap contents.
    #[arg(long)]
    mcp_share_metadata: bool,

    /// Use the indexed (CSR-based) analysis backend (default)
    #[arg(long, default_value_t = true)]
    indexed: bool,

    /// Use the legacy petgraph-based analysis backend
    #[arg(long)]
    legacy: bool,
    /// Reference storage; memory remains the default. Disk indices are private and reusable.
    #[arg(long, value_parser = ["memory", "disk"])]
    storage: Option<String>,
    #[arg(long)]
    cache_dir: Option<PathBuf>,
    /// Disk edge-sort buffer only, not a total RAM limit.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=1024))]
    edge_buffer_mib: Option<u64>,
}

/// JSON-RPC 2.0 Request structure.
#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    params: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 Notification structure (no id field).
#[derive(Debug, Serialize)]
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    params: serde_json::Value,
}

/// Per-phase timing breakdown in milliseconds.
#[derive(Debug, Clone, Serialize)]
struct TimingBreakdown {
    file_loading_ms: u64,
    graph_building_ms: u64,
    dominator_analysis_ms: u64,
    total_ms: u64,
}

/// Result of heap analysis.
#[derive(Debug, Clone, Serialize)]
struct AnalyzeHeapResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    storage: Option<hprof_analyzer::indexed::storage::StorageReport>,
    request_id: u64,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_objects: Option<Vec<hprof_analyzer::ObjectReport>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_layers: Option<Vec<hprof_analyzer::ObjectReport>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<hprof_analyzer::HeapSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_histogram: Option<Vec<hprof_analyzer::ClassHistogramEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leak_suspects: Option<Vec<hprof_analyzer::LeakSuspect>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_leak_suspects: Option<Vec<hprof_analyzer::LeakSuspect>>,
    waste_analysis: Option<WasteAnalysis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<TimingBreakdown>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Analysis state stored per file path.
#[derive(Clone)]
struct FileAnalysisState {
    generation: u64,
    /// The analysis state for querying (Arc-wrapped for cheap cloning).
    state: Arc<RwLock<Option<Arc<dyn HeapAnalysis>>>>,
    /// The file path this analysis is for.
    #[allow(dead_code)]
    path: PathBuf,
    /// Cached memory-mapped file for inspect_object (avoids re-mapping on each call).
    mmap: Option<Arc<memmap2::Mmap>>,
    /// Deferred edge data for Phase 2 (taken once by Phase 2).
    deferred_edge_data: Arc<std::sync::Mutex<Option<hprof_analyzer::indexed::parse::DeferredEdgeData>>>,
    /// Phase 1 result for Phase 2 (taken once by Phase 2).
    phase1_result: Arc<std::sync::Mutex<Option<hprof_analyzer::indexed::parse::Phase1Result>>>,
}

#[derive(Clone)]
struct AnalysisControl {
    request_id: u64,
    cancel_token: Arc<AtomicBool>,
}

impl AnalysisControl {
    fn accepts_cancel(&self, requested_analysis_id: Option<u64>) -> bool {
        requested_analysis_id
            .map(|id| id == self.request_id)
            .unwrap_or(true)
    }
}

impl FileAnalysisState {
    /// Takes the deferred edge data, leaving None in its place.
    fn take_deferred(&self) -> Option<hprof_analyzer::indexed::parse::DeferredEdgeData> {
        self.deferred_edge_data.lock().ok()?.take()
    }

    /// Takes the Phase 1 result, leaving None in its place.
    fn take_phase1(&self) -> Option<hprof_analyzer::indexed::parse::Phase1Result> {
        self.phase1_result.lock().ok()?.take()
    }
}

/// Performs the CPU-intensive heap analysis in a blocking task.
///
/// This function is meant to be called from `tokio::task::spawn_blocking`
/// to avoid blocking the async runtime.
///
/// The indexed path emits borrowed staged observations during this same job;
/// the returned terminal result contains only completed retained analysis.
fn analyze_heap_blocking(
    path: PathBuf,
    request_id: u64,
    analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    cancel_token: Arc<AtomicBool>,
    _result_tx: mpsc::UnboundedSender<AnalyzeHeapResult>,
) -> AnalyzeHeapResult {
    log::info!("Starting heap analysis for: {:?} (request_id: {})", path, request_id);

    let use_indexed = USE_INDEXED.load(Ordering::Relaxed);

    match analyze_heap_internal(
        &path,
        analysis_states.clone(),
        &cancel_token,
        use_indexed,
        Some(request_id),
    ) {
        Ok((top_objects, analysis_state, timing)) => {
            log::info!("Heap analysis completed successfully (request_id: {})", request_id);

            let top_layers: Vec<_> = top_objects.iter()
                .filter(|obj| obj.retained_size > 0 && obj.node_type != "Class")
                .take(20)
                .cloned()
                .collect();

            let phase1_result = AnalyzeHeapResult {
                storage: analysis_state.storage_report().cloned(),
                request_id,
                status: "completed".to_string(),
                top_objects: Some(top_objects),
                top_layers: Some(top_layers),
                summary: Some(analysis_state.get_summary().clone()),
                class_histogram: Some(analysis_state.get_class_histogram().to_vec()),
                leak_suspects: Some(analysis_state.get_leak_suspects().to_vec()),
                object_leak_suspects: Some(analysis_state.get_object_leak_suspects().to_vec()),
                waste_analysis: analysis_state.cached_waste_analysis().cloned(),
                timing: Some(timing.clone()),
                error: None,
            };

            phase1_result
        }
        Err(e) => {
            if cancel_token.load(Ordering::Relaxed) {
                log::info!("Heap analysis cancelled (request_id: {})", request_id);
                return AnalyzeHeapResult {
                    storage: None,
                    request_id,
                    status: "cancelled".to_string(),
                    top_objects: None,
                    top_layers: None,
                    summary: None,
                    class_histogram: None,
                    leak_suspects: None,
                    object_leak_suspects: None,
                    waste_analysis: None,
                    timing: None,
                    error: None,
                };
            }
            let error_msg = if let Some(resource) = e.downcast_ref::<hprof_analyzer::indexed::storage::ResourceError>() {
                format!("Heap analysis failed: {resource}")
            } else { format!("Heap analysis failed: {}", e) };
            log::error!("{} (request_id: {})", error_msg, request_id);
            AnalyzeHeapResult {
                storage: None,
                request_id,
                status: "error".to_string(),
                top_objects: None,
                top_layers: None,
                summary: None,
                class_histogram: None,
                leak_suspects: None,
                object_leak_suspects: None,
                waste_analysis: None,
                timing: None,
                error: Some(error_msg),
            }
        }
    }
}

/// Runs Phase 2 of the indexed analysis: edge extraction, CSR build, and
/// dominator computation. Updates the stored analysis state and sends a
/// `heap_analysis_phase2_complete` notification.
fn run_phase2_background(
    path: &PathBuf,
    request_id: u64,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    cancel_token: &Arc<AtomicBool>,
    phase1_timing: TimingBreakdown,
) {
    // Retrieve deferred data from the stored state (no mmap needed for Phase 2)
    let deferred_data = {
        let states = match analysis_states.read() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Phase2] Failed to read analysis states: {}", e);
                return;
            }
        };
        let file_state = match states.get(path) {
            Some(s) => s,
            None => {
                eprintln!("[Phase2] No file state found for {:?}", path);
                return;
            }
        };
        let deferred = match file_state.take_deferred() {
            Some(d) => d,
            None => {
                eprintln!("[Phase2] No deferred edge data found for {:?}", path);
                return;
            }
        };
        // Also get phase1 result
        let phase1 = match file_state.take_phase1() {
            Some(p) => p,
            None => {
                eprintln!("[Phase2] No phase1 result found for {:?}", path);
                return;
            }
        };
        (deferred, phase1)
    };

    if cancel_token.load(Ordering::Relaxed) {
        eprintln!("[Phase2] Analysis cancelled");
        return;
    }

    eprintln!("[Phase2] Starting edge extraction + dominator computation...");
    let phase2_start = Instant::now();

    let _ = send_stdout(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "heap_analysis_progress",
        "params": {
            "request_id": request_id,
            "stage": "phase2_edges",
            "message": "Extracting object references..."
        }
    }));

    let (deferred, phase1) = deferred_data;

    // Run Phase 2 parsing (no file rescan needed — all data collected in Phase 1)
    let phase2 = match hprof_analyzer::indexed::parse::parse_indexed_phase2(&phase1, deferred) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[Phase2] Edge extraction failed: {}", e);
            let _ = send_stdout(&serde_json::json!({
                "jsonrpc": "2.0",
                "method": "heap_analysis_phase2_complete",
                "params": {
                    "request_id": request_id,
                    "status": "error",
                    "error": format!("Phase 2 failed: {}", e)
                }
            }));
            return;
        }
    };

    if cancel_token.load(Ordering::Relaxed) {
        eprintln!("[Phase2] Analysis cancelled after edge extraction");
        return;
    }

    // Build full IndexedAnalysisState from Phase 1 + Phase 2
    let full_state = match hprof_analyzer::indexed::IndexedAnalysisState::from_phases(phase1, phase2) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Phase2] Dominator computation failed: {}", e);
            let _ = send_stdout(&serde_json::json!({
                "jsonrpc": "2.0",
                "method": "heap_analysis_phase2_complete",
                "params": {
                    "request_id": request_id,
                    "status": "error",
                    "error": format!("Phase 2 analysis failed: {}", e)
                }
            }));
            return;
        }
    };

    let phase2_ms = phase2_start.elapsed().as_millis() as u64;
    eprintln!("[Phase2] Complete: {} ms", phase2_ms);

    let full_state_arc: Arc<dyn HeapAnalysis> = Arc::new(full_state);

    // Collect Phase 2 data for notification before storing
    let top_objects = full_state_arc.get_top_layers(3, 50);
    let top_layers: Vec<_> = top_objects.iter()
        .filter(|obj| obj.retained_size > 0 && obj.node_type != "Class")
        .take(20)
        .cloned()
        .collect();
    let leak_suspects = full_state_arc.get_leak_suspects().to_vec();
    let object_leak_suspects = full_state_arc.get_object_leak_suspects().to_vec();
    let class_histogram = full_state_arc.get_class_histogram().to_vec();
    let summary = full_state_arc.get_summary().clone();
    let waste_analysis = full_state_arc.cached_waste_analysis().cloned();

    // Replace Phase1AnalysisState with full IndexedAnalysisState
    {
        let states = match analysis_states.read() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Phase2] Failed to read analysis states for replacement: {}", e);
                return;
            }
        };
        if let Some(file_state) = states.get(path) {
            let mut state_guard = file_state.state.write().unwrap();
            *state_guard = Some(full_state_arc);
        }
    }

    let timing = TimingBreakdown {
        file_loading_ms: phase1_timing.file_loading_ms,
        graph_building_ms: phase1_timing.graph_building_ms,
        dominator_analysis_ms: phase2_ms,
        total_ms: phase1_timing.file_loading_ms + phase1_timing.graph_building_ms + phase2_ms,
    };

    // Send Phase 2 completion notification
    let _ = send_stdout(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "heap_analysis_phase2_complete",
        "params": {
            "request_id": request_id,
            "status": "completed",
            "top_objects": top_objects,
            "top_layers": top_layers,
            "summary": summary,
            "class_histogram": class_histogram,
            "leak_suspects": leak_suspects,
            "object_leak_suspects": object_leak_suspects,
            "waste_analysis": waste_analysis,
            "timing": timing
        }
    }));

    eprintln!("[Phase2] Notification sent. Full analysis available.");
}

/// Internal function that performs the actual heap analysis.
fn analyze_heap_internal(
    path: &PathBuf,
    analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    cancel_token: &Arc<AtomicBool>,
    use_indexed: bool,
    request_id: Option<u64>,
) -> Result<(Vec<hprof_analyzer::ObjectReport>, Arc<dyn HeapAnalysis>, TimingBreakdown)> {
    let total_start = Instant::now();

    // Phase 1/4: Load and map the HPROF file
    eprintln!("[Progress] Step 1/4: Loading HPROF file...");
    let phase_start = Instant::now();
    let loader = HprofLoader::new(path.clone());
    let raw_mmap = loader.map_file()
        .with_context(|| format!("Failed to load HPROF file: {:?}", path))?;
    let mmap = Arc::new(raw_mmap);
    let file_loading_ms = phase_start.elapsed().as_millis() as u64;

    let file_size = mmap.len() as u64;
    let file_size_mb = file_size as f64 / (1024.0 * 1024.0);
    eprintln!("[Progress] HPROF file mapped: {:.2} MB", file_size_mb);
    log::info!("HPROF file mapped: {} bytes ({:.2} MB)", mmap.len(), file_size_mb);

    // Send loading progress with file metadata
    let loading_notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "heap_analysis_progress",
        "params": {
            "request_id": request_id,
            "stage": "loading",
            "phase": 1,
            "total_phases": 4,
            "file_metadata": {
                "file_size": file_size
            }
        }
    });
    if let Err(e) = send_stdout(&loading_notification) {
        eprintln!("[Progress] Failed to send loading notification: {}", e);
    }

    if cancel_token.load(Ordering::Relaxed) {
        anyhow::bail!("Analysis cancelled");
    }

    // Phase 2-4: Build graph, compute dominators (legacy or indexed path)
    let (top_objects, analysis_state, graph_building_ms, dominator_analysis_ms): (
        Vec<hprof_analyzer::ObjectReport>,
        Arc<dyn HeapAnalysis>,
        u64,
        u64,
    ) = if use_indexed {
        eprintln!("[Progress] Step 2/3: Phase 1 indexed parse (nodes only)...");
        let _ = send_stdout(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
                "request_id": request_id,
                "stage": "graph_building", "phase": 2, "total_phases": 3
            }
        }));

        let phase_start = Instant::now();
        let options = STORAGE.get().cloned().unwrap_or_default();
        let mut observe = |event: hprof_analyzer::indexed::progress::Observation<'_>| {
            if cancel_token.load(Ordering::Relaxed) { return; }
            let mut params = event.payload();
            params["request_id"] = serde_json::json!(request_id);
            let _ = send_stdout(&serde_json::json!({"jsonrpc":"2.0","method":"heap_analysis_progress","params":params}));
        };
        let (phase1, deferred, cached_phase2, storage_report) = if options.mode == hprof_analyzer::indexed::storage::StorageMode::Disk {
            let (phase1, phase2, report) = hprof_analyzer::indexed::storage::load_structure_observed(mmap.clone(), &options, cancel_token, &mut observe)
                .context("Disk structural index validation or construction failed; check private cache permissions and free space")?;
            (phase1, None, Some(phase2), report)
        } else {
            let (phase1, deferred) = hprof_analyzer::indexed::parse::parse_indexed_phase1_observed(mmap.clone(), None, cancel_token, &mut observe)
                .context("Indexed Phase 1 parse failed")?;
            (phase1, Some(deferred), None, hprof_analyzer::indexed::storage::StorageReport { mode: "memory", cache_status: "disabled", edge_buffer_bytes: 0 })
        };
        let graph_ms = phase_start.elapsed().as_millis() as u64;

        eprintln!("[Progress] Phase 1 complete: {} nodes ({} ms)", phase1.node_store.len(), graph_ms);

        let _ = send_stdout(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
                "request_id": request_id,
                "stage": "edges", "phase": 3, "total_phases": 4
            }
        }));

        if cancel_token.load(Ordering::Relaxed) { anyhow::bail!("Analysis cancelled"); }

        // Phase 2: edges + dominators (~1s after file rescan elimination)
        eprintln!("[Progress] Step 3/4: Extracting edges + computing dominators...");
        let phase_start = Instant::now();
        let phase2 = match cached_phase2 { Some(phase2) => phase2, None => hprof_analyzer::indexed::parse::parse_indexed_phase2_cancellable(&phase1, deferred.expect("memory mode deferred data"), cancel_token)
            .context("Indexed Phase 2 failed")? };
        observe(hprof_analyzer::indexed::progress::Observation::Stage("dominators"));
        if cancel_token.load(Ordering::Relaxed) {
            anyhow::bail!("Analysis cancelled");
        }
        let indexed_state = hprof_analyzer::indexed::IndexedAnalysisState::from_phases(phase1, phase2)
            .context("Indexed analysis state construction failed")?.with_storage_report(storage_report);
        if cancel_token.load(Ordering::Relaxed) {
            anyhow::bail!("Analysis cancelled");
        }
        let dom_ms = phase_start.elapsed().as_millis() as u64;

        let top = indexed_state.get_top_layers(3, 50);
        let analysis_state: Arc<dyn HeapAnalysis> = Arc::new(indexed_state);

        (top, analysis_state, graph_ms, dom_ms)
    } else {
        eprintln!("[Progress] Step 2/4: Building heap graph...");
        let _ = send_stdout(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
                "request_id": request_id,
                "stage": "graph_building", "phase": 2, "total_phases": 4
            }
        }));

        let phase_start = Instant::now();
        let (graph, waste_data) = build_graph(&mmap[..])
            .context("Failed to build heap graph")?;
        let graph_ms = phase_start.elapsed().as_millis() as u64;

        eprintln!("[Progress] Heap graph built: {} nodes, {} edges ({} ms)",
            graph.node_count(), graph.edge_count(), graph_ms);

        let _ = send_stdout(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
                "request_id": request_id,
                "stage": "graph_built", "phase": 3, "total_phases": 4,
                "summary": graph.summary().clone()
            }
        }));

        if cancel_token.load(Ordering::Relaxed) { anyhow::bail!("Analysis cancelled"); }

        eprintln!("[Progress] Step 4/4: Calculating dominators and retained sizes...");
        let _ = send_stdout(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
                "request_id": request_id,
                "stage": "dominators", "phase": 4, "total_phases": 4
            }
        }));

        let phase_start = Instant::now();
        let (top_objects, state) = calculate_dominators_with_state(graph, waste_data)
            .context("Failed to calculate dominators")?;
        if cancel_token.load(Ordering::Relaxed) {
            anyhow::bail!("Analysis cancelled");
        }
        let dom_ms = phase_start.elapsed().as_millis() as u64;

        (top_objects, Arc::new(state) as Arc<dyn HeapAnalysis>, graph_ms, dom_ms)
    };

    let total_ms = total_start.elapsed().as_millis() as u64;

    eprintln!("[Progress] Analysis complete: {} top objects ({} ms total)", top_objects.len(), total_ms);
    eprintln!("[Timing] Loading: {} ms | Graph: {} ms | Dominators: {} ms | Total: {} ms",
        file_loading_ms, graph_building_ms, dominator_analysis_ms, total_ms);
    log::info!("Analysis complete: {} top objects ({} ms total)", top_objects.len(), total_ms);

    // Store analysis state for lazy loading queries (legacy path)
    {
        let mut states = analysis_states.write()
            .map_err(|e| anyhow::anyhow!("Failed to write analysis states: {}", e))?;

        states.insert(path.clone(), FileAnalysisState {
            generation: request_id.unwrap_or(0),
            state: Arc::new(RwLock::new(Some(analysis_state.clone()))),
            path: path.clone(),
            mmap: Some(mmap),
            deferred_edge_data: Arc::new(std::sync::Mutex::new(None)),
            phase1_result: Arc::new(std::sync::Mutex::new(None)),
        });
    }

    log::debug!("Stored analysis state for: {:?}", path);

    let timing = TimingBreakdown {
        file_loading_ms,
        graph_building_ms,
        dominator_analysis_ms,
        total_ms,
    };

    Ok((top_objects, analysis_state, timing))
}

/// Writes a JSON value to stdout followed by a newline, then flushes.
fn send_stdout(value: &serde_json::Value) -> Result<()> {
    let json = serde_json::to_string(value)
        .context("Failed to serialize JSON")?;
    let stdout = io::stdout();
    let mut stdout_lock = stdout.lock();
    writeln!(stdout_lock, "{}", json)
        .context("Failed to write to stdout")?;
    stdout_lock.flush().context("Failed to flush stdout")?;
    Ok(())
}

/// Formats a byte count into a human-readable string.
// ============================================================================
// JSON-RPC Server (existing extension mode)
// ============================================================================

/// Shared manual/IDE lookup; never exposed through the scoped MCP tool boundary.
fn get_analysis_state_for_path(analysis_states:&Arc<RwLock<HashMap<PathBuf,FileAnalysisState>>>,path:&str)->std::result::Result<Arc<dyn HeapAnalysis>,String>{
    let states=analysis_states.read().map_err(|_|"Analysis unavailable".to_string())?;
    let file=states.get(&PathBuf::from(path)).ok_or_else(||"Analyze the file first".to_string())?;
    let state=file.state.read().map_err(|_|"Analysis unavailable".to_string())?;
    state.as_ref().cloned().ok_or_else(||"Analysis unavailable".to_string())
}

/// Runs the JSON-RPC server for VS Code extension communication.
async fn run_jsonrpc_server() -> Result<()> {
    let scan_readiness = scan_server::Readiness::default();
    let read_jobs = read_jobs::ReadJobs::default();
    let investigations = investigation_server::Jobs::default();
    let (result_tx, mut result_rx) = mpsc::unbounded_channel::<AnalyzeHeapResult>();
    let request_id_counter = Arc::new(AtomicU64::new(1));
    let analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let cancel_tokens: Arc<RwLock<HashMap<String, AnalysisControl>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Spawn task to process results and send notifications
    let notification_handle = task::spawn(async move {
        while let Some(result) = result_rx.recv().await {
            let notification = JsonRpcNotification {
                jsonrpc: "2.0".to_string(),
                method: "heap_analysis_complete".to_string(),
                params: serde_json::to_value(&result).unwrap_or_else(|e| {
                    serde_json::json!({
                        "request_id": result.request_id,
                        "status": "error",
                        "error": format!("Failed to serialize result: {}", e)
                    })
                }),
            };

            let json = match serde_json::to_string(&notification) {
                Ok(json) => json,
                Err(e) => {
                    eprintln!("Failed to serialize notification: {}", e);
                    continue;
                }
            };

            // Lock stdout only for the write operation, not across await
            {
                let stdout = io::stdout();
                let mut stdout_lock = stdout.lock();
                if let Err(e) = writeln!(stdout_lock, "{}", json) {
                    eprintln!("Failed to write notification: {}", e);
                    break;
                }
                if let Err(e) = stdout_lock.flush() {
                    eprintln!("Failed to flush stdout: {}", e);
                    break;
                }
            }
        }
    });

    // Handle stdin reading and process requests line-by-line (async)
    let request_handle = {
        let result_tx = result_tx.clone();
        let request_id_counter = request_id_counter.clone();
        let analysis_states = analysis_states.clone();
        let cancel_tokens = cancel_tokens.clone();
        task::spawn(async move {
            let stdin = tokio::io::stdin();
            let reader = BufReader::new(stdin);
            let mut lines = reader.lines();

            // Process each line as it arrives (non-blocking)
            while let Some(line_result) = lines.next_line().await.transpose() {
                let line = match line_result {
                    Ok(line) => line,
                    Err(e) => {
                        eprintln!("Failed to read line from stdin: {}", e);
                        break;
                    }
                };

                if line.trim().is_empty() {
                    continue;
                }

                let request: JsonRpcRequest = match serde_json::from_str(&line) {
                    Ok(req) => req,
                    Err(e) => {
                        eprintln!("Failed to parse JSON-RPC request: {} (line: {})", e, line);
                        continue;
                    }
                };

                // Dispatch RPC method
                match scan_readiness.reject_read(&request) {
                    Ok(true) => continue,
                    Err(error) => { eprintln!("Readiness check failed: {error}"); continue; }
                    Ok(false) => {}
                }
                let method = request.method.clone();
                if matches!(method.as_str(), "investigate_heap" | "cancel_investigation") {
                    investigations.handle(request, &analysis_states, &cancel_tokens, read_jobs.engine_gate());
                    continue;
                }
                if read_jobs::handles(&method) {
                    read_jobs.start(request, &analysis_states, &cancel_tokens);
                    continue;
                }
                let result = match method.as_str() {
                    "scan_heap" => scan_server::start(request, &request_id_counter, &analysis_states, &cancel_tokens, &scan_readiness, read_jobs.engine_gate()),
                    "analyze_heap" => handle_analyze_heap_request(
                        request, &result_tx, &request_id_counter, &analysis_states, &cancel_tokens, &scan_readiness, read_jobs.engine_gate(),
                    ).await,
                    "cancel_analysis" => handle_cancel_analysis_request(request, &cancel_tokens).await,
                    "ping" => {
                        if let Some(id) = request.id {
                            let response = serde_json::json!({
                                "jsonrpc": "2.0", "id": id, "result": { "status": "ok" }
                            });
                            send_stdout(&response).map_err(|e| e.into())
                        } else { Ok(()) }
                    }
                    "list_analyzed_files" => handle_list_analyzed_files_request(request, &analysis_states).await,
                    _ => {
                        if let Some(id) = request.id {
                            let error_response = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": {
                                    "code": -32601,
                                    "message": format!("Method not found: {}", method)
                                }
                            });
                            if let Err(e) = send_stdout(&error_response) {
                                eprintln!("Failed to send error response: {}", e);
                                break;
                            }
                        }
                        Ok(())
                    }
                };
                if let Err(e) = result {
                    eprintln!("Error handling {} request: {}", method, e);
                }
            }

            log::info!("Stdin closed, no more requests");
        })
    };

    // Wait for shutdown signal, stdin close, or notification completion
    tokio::select! {
        _ = signal::ctrl_c() => {
            log::info!("Received CTRL+C, shutting down...");
        }
        _ = request_handle => {
            log::info!("Stdin closed, waiting for remaining tasks...");
            // Give notifications time to finish
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }
        _ = notification_handle => {
            log::info!("All notifications sent");
        }
    }

    log::info!("Server shutdown complete");
    Ok(())
}

/// Handles an analyze_heap request without requiring the full Server struct.
async fn handle_analyze_heap_request(
    request: JsonRpcRequest,
    result_tx: &mpsc::UnboundedSender<AnalyzeHeapResult>,
    request_id_counter: &Arc<AtomicU64>,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    cancel_tokens: &Arc<RwLock<HashMap<String, AnalysisControl>>>,
    scan_readiness: &scan_server::Readiness,
    engine_gate: Arc<tokio::sync::RwLock<()>>,
) -> Result<()> {
    // Extract parameters
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let path_buf = PathBuf::from(path);
    let path_key = path.to_string();

    let request_id = request.id
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| request_id_counter.fetch_add(1, Ordering::Relaxed));

    // Create cancel token for this analysis
    let cancel_token = Arc::new(AtomicBool::new(false));
    if !scan_server::claim(cancel_tokens, &path_key, request_id, cancel_token.clone())? { return Ok(()); }
    // A failed/cancelled reanalysis must not expose a previous snapshot as if
    // it belonged to the new job. Queued readers pin and check identity.
    scan_readiness.scan(&path_key);
    analysis_states.write().map_err(|_|anyhow::anyhow!("Analysis registry unavailable"))?.remove(&path_buf);

    // Respond immediately with processing status
    let processing_response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "status": "processing",
            "request_id": request_id
        }
    });
    send_stdout(&processing_response)?;

    // Clone the result sender and analysis states for the blocking task
    let result_tx = result_tx.clone();
    let analysis_states = analysis_states.clone();
    let cancel_tokens_cleanup = cancel_tokens.clone();
    let scan_readiness = scan_readiness.clone();

    // Spawn blocking task for CPU-intensive work
    task::spawn_blocking(move || {
        let _engine = engine_gate.blocking_write();
        let result = analyze_heap_blocking(path_buf, request_id, analysis_states, cancel_token, result_tx.clone());
        if result.status == "completed" { scan_readiness.full(&path_key); }

        // Clean up cancel token
        if let Ok(mut tokens) = cancel_tokens_cleanup.write() {
            let owns_path_entry = tokens.get(&path_key)
                .map(|control| control.request_id == request_id)
                .unwrap_or(false);
            if owns_path_entry {
                tokens.remove(&path_key);
            }
        }

        if let Err(e) = result_tx.send(result) {
            eprintln!("Failed to send analysis result: {}", e);
        }
    });

    Ok(())
}

/// Handles a cancel_analysis request.
async fn handle_cancel_analysis_request(
    request: JsonRpcRequest,
    cancel_tokens: &Arc<RwLock<HashMap<String, AnalysisControl>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let requested_analysis_id = params
        .get("analysis_request_id")
        .and_then(|v| v.as_u64());

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let (cancelled, analysis_request_id) = if let Ok(tokens) = cancel_tokens.read() {
        if let Some(control) = tokens.get(path) {
            if control.accepts_cancel(requested_analysis_id) {
                control.cancel_token.store(true, Ordering::Relaxed);
                (true, Some(control.request_id))
            } else {
                (false, Some(control.request_id))
            }
        } else {
            (false, None)
        }
    } else {
        (false, None)
    };

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "cancelled": cancelled,
            "analysis_request_id": analysis_request_id
        }
    });
    send_stdout(&response)?;

    // Send cancelled progress notification
    if cancelled {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
                "request_id": analysis_request_id,
                "stage": "cancelled"
            }
        });
        if let Err(e) = send_stdout(&notification) {
            eprintln!("Failed to send cancelled notification: {}", e);
        }
    }

    Ok(())
}

/// Handles a get_children request without requiring the full Server struct.
async fn handle_get_children_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    // Extract parameters
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let object_id = params
        .get("object_id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'object_id' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    // Get analysis state for this file
    let analysis_states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let file_state = analysis_states_guard.get(&PathBuf::from(path))
        .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;

    let state_guard = file_state.state.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;

    let analysis_state = state_guard.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;

    // Get children — return empty array if node not found or has no children
    let children = analysis_state.get_children(object_id).unwrap_or_default();
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": children
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles a get_referrers request.
async fn handle_get_referrers_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let object_id = params
        .get("object_id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'object_id' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let analysis_states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let file_state = analysis_states_guard.get(&PathBuf::from(path))
        .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;

    let state_guard = file_state.state.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;

    let analysis_state = state_guard.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;

    let referrers = analysis_state.get_referrers(object_id).unwrap_or_default();
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": referrers
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles an export_json request.
async fn handle_export_json_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let output_path = params
        .get("output_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'output_path' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let analysis_states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let file_state = analysis_states_guard.get(&PathBuf::from(path))
        .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;

    let state_guard = file_state.state.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;

    let analysis_state = state_guard.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;

    // Build export data
    let top_objects = analysis_state.get_top_layers(3, 100);

    let export_data = serde_json::json!({
        "source_file": path,
        "summary": analysis_state.get_summary(),
        "class_histogram": analysis_state.get_class_histogram(),
        "leak_suspects": analysis_state.get_leak_suspects(),
        "object_leak_suspects": analysis_state.get_object_leak_suspects(),
        "top_objects": top_objects,
    });

    // Write to file
    let export_json = serde_json::to_string_pretty(&export_data)
        .context("Failed to serialize export data")?;
    std::fs::write(output_path, export_json)
        .context("Failed to write export file")?;

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "success": true }
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles a gc_root_path request.
async fn handle_gc_root_path_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let object_id = params
        .get("object_id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'object_id' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let analysis_states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let file_state = analysis_states_guard.get(&PathBuf::from(path))
        .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;

    let state_guard = file_state.state.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;

    let analysis_state = state_guard.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;

    let gc_path = analysis_state.gc_root_path(object_id, 100);
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": gc_path
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles an inspect_object request.
async fn handle_inspect_object_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let object_id = params
        .get("object_id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'object_id' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let (analysis_state, mmap_clone) = {
        let states = analysis_states.read()
            .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;
        let file_state = states.get(&PathBuf::from(path))
            .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;
        let state_guard = file_state.state.read()
            .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;
        let state = state_guard.as_ref()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;
        let mmap = file_state.mmap.clone();
        (state, mmap)
    };
    let path_owned = path.to_string();

    // Already running on a bounded read worker; do not spawn a second pool.
    let fields = {
        if let Some(ref cached_mmap) = mmap_clone {
            analysis_state.inspect_object_bytes(&cached_mmap[..], object_id)
        } else {
            let hprof_path = std::path::Path::new(&path_owned);
            analysis_state.inspect_object(hprof_path, object_id)
        }
    };

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": fields
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles an execute_query request.
async fn handle_execute_query_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let query = params
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'query' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let analysis_states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let file_state = analysis_states_guard.get(&PathBuf::from(path))
        .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;

    let state_guard = file_state.state.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;

    let analysis_state = state_guard.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;

    // Support optional server-side pagination
    let page = params.get("page").and_then(|v| v.as_u64());
    let page_size = params.get("page_size").and_then(|v| v.as_u64()).unwrap_or(500);

    let response = match if let Some(p) = page {
        analysis_state.execute_query_paged(query, p, page_size)
    } else {
        analysis_state.execute_query(query)
    } {
        Ok(result) => serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result
        }),
        Err(e) => serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32000,
                "message": e.to_string()
            }
        }),
    };
    send_stdout(&response)?;

    Ok(())
}

/// Handles a list_analyzed_files request.
async fn handle_list_analyzed_files_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let states = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let files: Vec<String> = states.keys()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": files
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles a compare_heaps request.
async fn handle_compare_heaps_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let current_path = params
        .get("current_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'current_path' parameter"))?;
    let baseline_path = params
        .get("baseline_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'baseline_path' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let current_state = get_analysis_state_for_path(analysis_states, current_path)
        .map_err(|e| anyhow::anyhow!(e))?;
    let baseline_state = get_analysis_state_for_path(analysis_states, baseline_path)
        .map_err(|e| anyhow::anyhow!(e))?;

    let result = compare_heaps(&*baseline_state, &*current_state, baseline_path, current_path);

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles a get_timeline_data request for snapshot timeline.
async fn handle_get_timeline_data_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let paths: Vec<String> = params
        .get("paths")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'paths' parameter"))?;
    let top_n = params
        .get("top_n")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let mut snapshots: Vec<serde_json::Value> = Vec::new();

    for path_str in &paths {
        let path = PathBuf::from(path_str);
        if let Some(file_state) = states_guard.get(&path) {
            if let Ok(state_guard) = file_state.state.read() {
                if let Some(ref analysis_state) = *state_guard {
                    let snapshot = analysis_state.get_timeline_snapshot(path_str, top_n);
                    // Get file mtime as timestamp
                    let timestamp = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let mut val = serde_json::to_value(&snapshot).unwrap_or_default();
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert("timestamp".to_string(), serde_json::json!(timestamp));
                    }
                    snapshots.push(val);
                }
            }
        }
    }

    // Sort by timestamp
    snapshots.sort_by(|a, b| {
        let ta = a.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
        ta.cmp(&tb)
    });

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "snapshots": snapshots }
    });
    send_stdout(&response)?;

    Ok(())
}

/// Handles a get_dominator_subtree request for flame graph / icicle chart.
async fn handle_get_dominator_subtree_request(
    request: JsonRpcRequest,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;
    let object_id = params
        .get("object_id")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let max_depth = params
        .get("max_depth")
        .and_then(|v| v.as_u64())
        .unwrap_or(6) as usize;
    let max_children = params
        .get("max_children")
        .and_then(|v| v.as_u64())
        .unwrap_or(20) as usize;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let analysis_state = get_analysis_state_for_path(analysis_states, path)
        .map_err(|e| anyhow::anyhow!(e))?;

    let subtree = analysis_state.get_dominator_subtree(object_id, max_depth, max_children);

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": subtree
    });
    send_stdout(&response)?;

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .init();

    let cli = Cli::parse();
    let mut storage = hprof_analyzer::indexed::storage::StorageOptions::from_env()?;
    if let Some(mode) = &cli.storage { storage.mode = hprof_analyzer::indexed::storage::StorageMode::parse(mode)?; }
    if let Some(directory) = &cli.cache_dir { storage.cache_dir = Some(directory.clone()); }
    if let Some(mib) = cli.edge_buffer_mib { storage.set_buffer_mib(mib as usize)?; }
    anyhow::ensure!(!cli.legacy || storage.mode == hprof_analyzer::indexed::storage::StorageMode::Memory, "Disk storage requires the indexed backend");
    let _ = STORAGE.set(storage);

    if cli.legacy {
        USE_INDEXED.store(false, Ordering::Relaxed);
        log::info!("Using legacy petgraph-based analysis backend");
    } else {
        USE_INDEXED.store(true, Ordering::Relaxed);
        log::info!("Using indexed (CSR-based) analysis backend");
    }

    if cli.mcp {
        log::set_max_level(log::LevelFilter::Off);
        log::info!("Starting HeapLens MCP server");
        mcp_scope::run(cli.mcp_allow_file,cli.mcp_share_metadata,STORAGE.get().cloned().unwrap_or_default()).await
    } else {
        log::info!("Starting HPROF analysis server (JSON-RPC mode)");
        run_jsonrpc_server().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_targets_only_the_requested_analysis() {
        let control = AnalysisControl {
            request_id: 42,
            cancel_token: Arc::new(AtomicBool::new(false)),
        };

        assert!(control.accepts_cancel(None), "legacy clients remain supported");
        assert!(control.accepts_cancel(Some(42)));
        assert!(!control.accepts_cancel(Some(99)));
    }
}
