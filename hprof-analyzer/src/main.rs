//! Async JSON-RPC server and MCP server for HPROF analysis
//!
//! This server reads JSON-RPC requests from stdin and processes CPU-intensive
//! heap analysis tasks asynchronously using tokio blocking tasks.
//!
//! When run with `--mcp`, it operates as an MCP (Model Context Protocol) server
//! for use with AI clients like Claude Desktop.

use anyhow::{Context, Result};
use clap::Parser;
use hprof_analyzer::{build_graph, calculate_dominators_with_state, compare_heaps, FieldInfo, HprofLoader, WasteAnalysis};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
#[derive(Debug, Serialize)]
struct AnalyzeHeapResult {
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
    waste_analysis: Option<WasteAnalysis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<TimingBreakdown>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Analysis state stored per file path.
#[derive(Clone)]
struct FileAnalysisState {
    /// The analysis state for querying children (Arc-wrapped for cheap cloning).
    state: Arc<RwLock<Option<Arc<hprof_analyzer::AnalysisState>>>>,
    /// The file path this analysis is for.
    #[allow(dead_code)]
    path: PathBuf,
    /// Cached memory-mapped file for inspect_object (avoids re-mapping on each call).
    mmap: Option<Arc<memmap2::Mmap>>,
}

/// Performs the CPU-intensive heap analysis in a blocking task.
///
/// This function is meant to be called from `tokio::task::spawn_blocking`
/// to avoid blocking the async runtime.
fn analyze_heap_blocking(
    path: PathBuf,
    request_id: u64,
    analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    cancel_token: Arc<AtomicBool>,
) -> AnalyzeHeapResult {
    log::info!("Starting heap analysis for: {:?} (request_id: {})", path, request_id);

    match analyze_heap_internal(&path, analysis_states.clone(), &cancel_token) {
        Ok((top_objects, analysis_state, timing)) => {
            log::info!("Heap analysis completed successfully (request_id: {})", request_id);

            let top_layers: Vec<_> = top_objects.iter()
                .filter(|obj| obj.retained_size > 0 && obj.node_type != "Class")
                .take(20)
                .cloned()
                .collect();

            AnalyzeHeapResult {
                request_id,
                status: "completed".to_string(),
                top_objects: Some(top_objects),
                top_layers: Some(top_layers),
                summary: Some(analysis_state.summary.clone()),
                class_histogram: Some(analysis_state.class_histogram.clone()),
                leak_suspects: Some(analysis_state.leak_suspects.clone()),
                waste_analysis: Some(analysis_state.waste_analysis.clone()),
                timing: Some(timing),
                error: None,
            }
        }
        Err(e) => {
            let error_msg = format!("Heap analysis failed: {}", e);
            log::error!("{} (request_id: {})", error_msg, request_id);
            AnalyzeHeapResult {
                request_id,
                status: "error".to_string(),
                top_objects: None,
                top_layers: None,
                summary: None,
                class_histogram: None,
                leak_suspects: None,
                waste_analysis: None,
                timing: None,
                error: Some(error_msg),
            }
        }
    }
}

/// Internal function that performs the actual heap analysis.
fn analyze_heap_internal(
    path: &PathBuf,
    analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    cancel_token: &Arc<AtomicBool>,
) -> Result<(Vec<hprof_analyzer::ObjectReport>, Arc<hprof_analyzer::AnalysisState>, TimingBreakdown)> {
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

    // Phase 2/4: Build the heap graph
    eprintln!("[Progress] Step 2/4: Building heap graph...");
    let graph_building_notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "heap_analysis_progress",
        "params": {
            "stage": "graph_building",
            "phase": 2,
            "total_phases": 4
        }
    });
    if let Err(e) = send_stdout(&graph_building_notification) {
        eprintln!("[Progress] Failed to send graph_building notification: {}", e);
    }

    let phase_start = Instant::now();
    let (graph, waste_data) = build_graph(&mmap[..])
        .context("Failed to build heap graph")?;
    let graph_building_ms = phase_start.elapsed().as_millis() as u64;

    eprintln!("[Progress] Heap graph built: {} nodes, {} edges ({} ms)",
                graph.node_count(),
                graph.edge_count(),
                graph_building_ms);
    log::info!("Heap graph built: {} nodes, {} edges",
                graph.node_count(),
                graph.edge_count());

    // Phase 3/4: Graph built — emit summary stats for early rendering
    let progress_summary = graph.summary().clone();
    let progress_notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "heap_analysis_progress",
        "params": {
            "stage": "graph_built",
            "phase": 3,
            "total_phases": 4,
            "summary": progress_summary
        }
    });
    if let Err(e) = send_stdout(&progress_notification) {
        eprintln!("[Progress] Failed to send progress notification: {}", e);
    }

    if cancel_token.load(Ordering::Relaxed) {
        anyhow::bail!("Analysis cancelled");
    }

    // Phase 4/4: Calculate dominators and retained sizes
    eprintln!("[Progress] Step 4/4: Calculating dominators and retained sizes...");
    let dominators_notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "heap_analysis_progress",
        "params": {
            "stage": "dominators",
            "phase": 4,
            "total_phases": 4
        }
    });
    if let Err(e) = send_stdout(&dominators_notification) {
        eprintln!("[Progress] Failed to send dominators notification: {}", e);
    }

    let phase_start = Instant::now();
    let (top_objects, analysis_state) = calculate_dominators_with_state(graph, waste_data)
        .context("Failed to calculate dominators")?;
    let dominator_analysis_ms = phase_start.elapsed().as_millis() as u64;

    let total_ms = total_start.elapsed().as_millis() as u64;

    eprintln!("[Progress] Analysis complete: {} top objects ({} ms total)", top_objects.len(), total_ms);
    eprintln!("[Timing] Loading: {} ms | Graph: {} ms | Dominators: {} ms | Total: {} ms",
        file_loading_ms, graph_building_ms, dominator_analysis_ms, total_ms);
    log::info!("Analysis complete: {} top objects ({} ms total)", top_objects.len(), total_ms);

    // Wrap in Arc for cheap cloning on queries
    let analysis_state = Arc::new(analysis_state);

    // Step 4: Store analysis state for lazy loading queries
    {
        let mut states = analysis_states.write()
            .map_err(|e| anyhow::anyhow!("Failed to write analysis states: {}", e))?;

        states.insert(path.clone(), FileAnalysisState {
            state: Arc::new(RwLock::new(Some(analysis_state.clone()))),
            path: path.clone(),
            mmap: Some(mmap),
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
fn fmt_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB"];
    let k = 1024_f64;
    let i = (bytes as f64).log(k).floor() as usize;
    let i = i.min(units.len() - 1);
    let val = bytes as f64 / k.powi(i as i32);
    if i > 1 {
        format!("{:.2} {}", val, units[i])
    } else {
        format!("{:.0} {}", val, units[i])
    }
}

// ============================================================================
// MCP Server
// ============================================================================

/// Returns the MCP tool definitions.
fn mcp_tool_definitions() -> serde_json::Value {
    serde_json::json!({
        "tools": [
            {
                "name": "analyze_heap",
                "description": "Analyze a Java heap dump (.hprof file). This must be called before using any other tools. The analysis may take 10-30 seconds for large files. Returns a summary with top objects, leak suspects, and class histogram.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "get_leak_suspects",
                "description": "Get detected memory leak suspects from a previously analyzed heap dump. Shows objects or classes retaining >10% of the heap.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "get_class_histogram",
                "description": "Get the class histogram showing instance counts, shallow sizes, and retained sizes per class. Useful for identifying which classes use the most memory.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of entries to return (default: 30)"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "drill_down",
                "description": "Get the children of a specific object in the dominator tree. Use this to explore what an object retains. The object_id comes from previous analyze_heap or drill_down results.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        },
                        "object_id": {
                            "type": "integer",
                            "description": "The object ID to drill into (from previous results)"
                        }
                    },
                    "required": ["path", "object_id"]
                }
            },
            {
                "name": "get_summary",
                "description": "Get heap summary statistics: total heap size, object count, class count, array count, and GC roots.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "get_waste_analysis",
                "description": "Get waste analysis showing duplicate strings and empty collections. Identifies recoverable memory waste without code changes: duplicate String instances with identical content, and empty HashMap/ArrayList/LinkedHashMap instances.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "execute_heapql",
                "description": "Execute a HeapQL query against a previously analyzed heap dump. HeapQL is a SQL-like language for querying heap data.\n\nTables: instances (object_id, node_type, class_name, shallow_size, retained_size), class_histogram (class_name, instance_count, shallow_size, retained_size), dominator_tree (same as instances; use WHERE object_id = X to drill into a specific node), leak_suspects (class_name, object_id, retained_size, retained_percentage, description).\n\nOperators: =, !=, >, <, >=, <=, LIKE (with % wildcards). Clauses: WHERE, AND, OR, ORDER BY [ASC|DESC], LIMIT.\n\nSpecial commands: :path <id> (GC root path), :refs <id> (referrers), :children <id> (dominator tree children), :info <id> (object details).\n\nExamples:\n- SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 10\n- SELECT * FROM instances WHERE class_name LIKE '%Cache%' AND retained_size > 1024\n- :path 12345\n- :info 12345",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        },
                        "query": {
                            "type": "string",
                            "description": "HeapQL query string"
                        }
                    },
                    "required": ["path", "query"]
                }
            },
            {
                "name": "inspect_object",
                "description": "Inspect all fields of a specific object instance. Returns field names, types, primitive values, and reference summaries (class name + retained size). Use the object_id from drill_down or execute_heapql results.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the .hprof file (must have been analyzed first)"
                        },
                        "object_id": {
                            "type": "integer",
                            "description": "The HPROF object ID to inspect"
                        }
                    },
                    "required": ["path", "object_id"]
                }
            },
            {
                "name": "compare_heaps",
                "description": "Compare two previously analyzed heap dumps to see what changed. Shows summary deltas, class histogram changes (grew/shrank/new/removed), leak suspect changes (new/resolved/persisted), and waste deltas. Both files must have been analyzed first.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "current_path": {
                            "type": "string",
                            "description": "Absolute path to the current (newer) .hprof file"
                        },
                        "baseline_path": {
                            "type": "string",
                            "description": "Absolute path to the baseline (older) .hprof file"
                        }
                    },
                    "required": ["current_path", "baseline_path"]
                }
            }
        ]
    })
}

/// Gets the analysis state for a file path, returning an error text if not found.
/// Returns an Arc<AnalysisState> — cloning the Arc is a single atomic increment.
fn get_analysis_state_for_path(
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
    path: &str,
) -> std::result::Result<Arc<hprof_analyzer::AnalysisState>, String> {
    let states = analysis_states.read()
        .map_err(|e| format!("Internal error: {}", e))?;
    let file_state = states.get(&PathBuf::from(path))
        .ok_or_else(|| format!("No analysis found for '{}'. Call analyze_heap first.", path))?;
    let state_guard = file_state.state.read()
        .map_err(|e| format!("Internal error: {}", e))?;
    state_guard.as_ref()
        .cloned()
        .ok_or_else(|| "Analysis state not available".to_string())
}

/// Formats the analyze_heap result as LLM-friendly markdown.
fn format_analyze_result(
    state: &hprof_analyzer::AnalysisState,
    top_objects: &[hprof_analyzer::ObjectReport],
) -> String {
    let s = &state.summary;
    let mut out = String::new();

    out.push_str("## Heap Summary\n\n");
    out.push_str(&format!("- **Total Heap Size:** {}\n", fmt_bytes(s.total_heap_size)));
    out.push_str(&format!("- **Objects:** {}\n", s.total_instances));
    out.push_str(&format!("- **Classes:** {}\n", s.total_classes));
    out.push_str(&format!("- **Arrays:** {}\n", s.total_arrays));
    out.push_str(&format!("- **GC Roots:** {}\n\n", s.total_gc_roots));

    // Top 20 objects
    let filtered: Vec<_> = top_objects.iter()
        .filter(|o| o.retained_size > 0 && o.node_type != "Class" && o.node_type != "SuperRoot")
        .take(20)
        .collect();

    if !filtered.is_empty() {
        out.push_str("## Top Objects by Retained Size\n\n");
        out.push_str("| # | Class | Type | Shallow | Retained |\n");
        out.push_str("|---|-------|------|---------|----------|\n");
        for (i, obj) in filtered.iter().enumerate() {
            let name = if obj.class_name.is_empty() { &obj.node_type } else { &obj.class_name };
            out.push_str(&format!("| {} | {} | {} | {} | {} |\n",
                i + 1, name, obj.node_type,
                fmt_bytes(obj.shallow_size), fmt_bytes(obj.retained_size)));
        }
        out.push('\n');
    }

    // Leak suspects
    if !state.leak_suspects.is_empty() {
        out.push_str("## Leak Suspects\n\n");
        for suspect in &state.leak_suspects {
            let severity = if suspect.retained_percentage > 30.0 { "HIGH" } else { "MEDIUM" };
            out.push_str(&format!("- **[{}] {}** - retains {:.1}% of heap ({}) - {}\n",
                severity, suspect.class_name, suspect.retained_percentage,
                fmt_bytes(suspect.retained_size), suspect.description));
        }
        out.push('\n');
    }

    // Top 10 histogram
    let hist_count = state.class_histogram.len().min(10);
    if hist_count > 0 {
        out.push_str("## Top Classes by Retained Size\n\n");
        out.push_str("| Class | Instances | Shallow | Retained |\n");
        out.push_str("|-------|-----------|---------|----------|\n");
        for entry in state.class_histogram.iter().take(hist_count) {
            out.push_str(&format!("| {} | {} | {} | {} |\n",
                entry.class_name, entry.instance_count,
                fmt_bytes(entry.shallow_size), fmt_bytes(entry.retained_size)));
        }
    }

    // Waste analysis
    let w = &state.waste_analysis;
    if w.total_wasted_bytes > 0 {
        out.push_str("\n## Waste Analysis\n\n");
        out.push_str(&format!("- **Total Waste:** {} ({:.1}% of heap)\n", fmt_bytes(w.total_wasted_bytes), w.waste_percentage));
        out.push_str(&format!("- **Duplicate Strings:** {}\n", fmt_bytes(w.duplicate_string_wasted_bytes)));
        out.push_str(&format!("- **Empty Collections:** {}\n", fmt_bytes(w.empty_collection_wasted_bytes)));
        if !w.duplicate_strings.is_empty() {
            out.push_str("\nTop duplicate strings:\n");
            for ds in w.duplicate_strings.iter().take(5) {
                let preview = if ds.preview.len() > 60 { &ds.preview[..60] } else { &ds.preview };
                out.push_str(&format!("- \"{}\" x{} (wastes {})\n", preview, ds.count, fmt_bytes(ds.wasted_bytes)));
            }
        }
    }

    out
}

/// Formats leak suspects as markdown.
fn format_leak_suspects(suspects: &[hprof_analyzer::LeakSuspect]) -> String {
    if suspects.is_empty() {
        return "No leak suspects detected. No single object or class retains more than 10% of the heap.".to_string();
    }

    let mut out = String::from("## Leak Suspects\n\n");
    for (i, s) in suspects.iter().enumerate() {
        let severity = if s.retained_percentage > 30.0 { "HIGH" } else { "MEDIUM" };
        out.push_str(&format!("### {}. [{}] {}\n\n", i + 1, severity, s.class_name));
        out.push_str(&format!("- **Retained:** {} ({:.1}% of heap)\n", fmt_bytes(s.retained_size), s.retained_percentage));
        if s.object_id > 0 {
            out.push_str(&format!("- **Object ID:** {} (use `drill_down` to explore)\n", s.object_id));
        }
        out.push_str(&format!("- **Description:** {}\n\n", s.description));
    }
    out
}

/// Formats class histogram as markdown.
fn format_class_histogram(histogram: &[hprof_analyzer::ClassHistogramEntry], limit: usize) -> String {
    if histogram.is_empty() {
        return "No class histogram data available.".to_string();
    }

    let count = histogram.len().min(limit);
    let mut out = format!("## Class Histogram (top {} of {})\n\n", count, histogram.len());
    out.push_str("| # | Class | Instances | Shallow | Retained |\n");
    out.push_str("|---|-------|-----------|---------|----------|\n");
    for (i, entry) in histogram.iter().take(count).enumerate() {
        out.push_str(&format!("| {} | {} | {} | {} | {} |\n",
            i + 1, entry.class_name, entry.instance_count,
            fmt_bytes(entry.shallow_size), fmt_bytes(entry.retained_size)));
    }
    out
}

/// Formats drill-down children as markdown.
fn format_children(children: &[hprof_analyzer::ObjectReport], object_id: u64) -> String {
    if children.is_empty() {
        return format!("Object {} has no children in the dominator tree (leaf node).", object_id);
    }

    let mut out = format!("## Children of Object {} ({} entries)\n\n", object_id, children.len());
    out.push_str("| # | Class | Type | Object ID | Shallow | Retained |\n");
    out.push_str("|---|-------|------|-----------|---------|----------|\n");
    for (i, child) in children.iter().enumerate() {
        let name = if child.class_name.is_empty() { &child.node_type } else { &child.class_name };
        out.push_str(&format!("| {} | {} | {} | {} | {} | {} |\n",
            i + 1, name, child.node_type, child.object_id,
            fmt_bytes(child.shallow_size), fmt_bytes(child.retained_size)));
    }
    out.push_str("\nUse `drill_down` with any object_id above to explore deeper.");
    out
}

/// Formats heap summary as markdown.
fn format_summary(summary: &hprof_analyzer::HeapSummary) -> String {
    let mut out = String::from("## Heap Summary\n\n");
    out.push_str(&format!("- **Total Heap Size:** {}\n", fmt_bytes(summary.total_heap_size)));
    out.push_str(&format!("- **Reachable Heap Size:** {}\n", fmt_bytes(summary.reachable_heap_size)));
    out.push_str(&format!("- **Total Objects (instances):** {}\n", summary.total_instances));
    out.push_str(&format!("- **Total Classes:** {}\n", summary.total_classes));
    out.push_str(&format!("- **Total Arrays:** {}\n", summary.total_arrays));
    out.push_str(&format!("- **GC Roots:** {}\n", summary.total_gc_roots));
    out
}

/// Formats waste analysis as standalone markdown.
fn format_waste_analysis(waste: &WasteAnalysis) -> String {
    if waste.total_wasted_bytes == 0 {
        return "No significant memory waste detected. No duplicate strings or empty collections found.".to_string();
    }

    let mut out = String::from("## Waste Analysis\n\n");
    out.push_str(&format!("- **Total Waste:** {} ({:.1}% of heap)\n", fmt_bytes(waste.total_wasted_bytes), waste.waste_percentage));
    out.push_str(&format!("- **Duplicate Strings:** {}\n", fmt_bytes(waste.duplicate_string_wasted_bytes)));
    out.push_str(&format!("- **Empty Collections:** {}\n\n", fmt_bytes(waste.empty_collection_wasted_bytes)));

    if !waste.duplicate_strings.is_empty() {
        let count = waste.duplicate_strings.len().min(20);
        out.push_str(&format!("### Duplicate Strings (top {} of {})\n\n", count, waste.duplicate_strings.len()));
        out.push_str("| # | Preview | Copies | Wasted | Total |\n");
        out.push_str("|---|---------|--------|--------|-------|\n");
        for (i, ds) in waste.duplicate_strings.iter().take(count).enumerate() {
            let preview = if ds.preview.len() > 60 { format!("{}...", &ds.preview[..60]) } else { ds.preview.clone() };
            out.push_str(&format!("| {} | \"{}\" | {} | {} | {} |\n",
                i + 1, preview, ds.count, fmt_bytes(ds.wasted_bytes), fmt_bytes(ds.total_bytes)));
        }
        out.push('\n');
    }

    if !waste.empty_collections.is_empty() {
        out.push_str(&format!("### Empty Collections ({} types)\n\n", waste.empty_collections.len()));
        out.push_str("| Class | Count | Wasted |\n");
        out.push_str("|-------|-------|--------|\n");
        for ec in &waste.empty_collections {
            out.push_str(&format!("| {} | {} | {} |\n", ec.class_name, ec.count, fmt_bytes(ec.wasted_bytes)));
        }
    }

    out
}

/// Formats a HeapQL QueryResult as a markdown table for MCP output.
fn format_query_result(result: &hprof_analyzer::heapql::QueryResult) -> String {
    let mut out = String::new();

    if result.rows.is_empty() {
        out.push_str("No results.\n");
    } else {
        // Header
        out.push_str("| ");
        for col in &result.columns {
            out.push_str(col);
            out.push_str(" | ");
        }
        out.push('\n');

        // Separator
        out.push_str("| ");
        for _ in &result.columns {
            out.push_str("--- | ");
        }
        out.push('\n');

        // Rows (cap at 50 for readability)
        let max_rows = result.rows.len().min(50);
        for row in result.rows.iter().take(max_rows) {
            out.push_str("| ");
            for (i, val) in row.iter().enumerate() {
                let col_name = result.columns.get(i).map(|s| s.as_str()).unwrap_or("");
                let formatted = if col_name.ends_with("_size") || col_name == "shallow_size" || col_name == "retained_size" {
                    if let Some(n) = val.as_u64() {
                        fmt_bytes(n)
                    } else {
                        format_json_value(val)
                    }
                } else {
                    format_json_value(val)
                };
                out.push_str(&formatted);
                out.push_str(" | ");
            }
            out.push('\n');
        }
        if result.rows.len() > 50 {
            out.push_str(&format!("\n... and {} more rows\n", result.rows.len() - 50));
        }
    }

    out.push_str(&format!(
        "\n_Scanned: {} | Matched: {} | Returned: {} | Time: {:.1}ms_\n",
        result.total_scanned, result.total_matched, result.rows.len(), result.execution_time_ms
    ));
    out
}

/// Formats a signed byte delta with +/- prefix and human-readable units.
fn fmt_delta_bytes(delta: i64) -> String {
    let sign = if delta > 0 { "+" } else if delta < 0 { "-" } else { return "0 B".to_string() };
    let abs = delta.unsigned_abs();
    format!("{}{}", sign, fmt_bytes(abs))
}

/// Formats an inspect_object result as a markdown table.
fn format_inspect_result(fields: &[FieldInfo]) -> String {
    let mut out = String::new();
    out.push_str("## Object Fields\n\n");
    out.push_str("| Field | Type | Value / Reference | Retained Size |\n");
    out.push_str("|-------|------|-------------------|---------------|\n");
    for f in fields {
        let value = if let Some(ref pv) = f.primitive_value {
            pv.clone()
        } else if let Some(ref_id) = f.ref_object_id {
            if let Some(ref summary) = f.ref_summary {
                format!("{} (0x{:x})", summary.class_name, ref_id)
            } else {
                format!("0x{:x}", ref_id)
            }
        } else {
            "—".to_string()
        };
        let retained = if let Some(ref summary) = f.ref_summary {
            fmt_bytes(summary.retained_size)
        } else {
            "—".to_string()
        };
        out.push_str(&format!("| {} | {} | {} | {} |\n", f.name, f.field_type, value, retained));
    }
    out
}

/// Formats a comparison result as LLM-friendly markdown.
fn format_comparison_result(result: &hprof_analyzer::HeapComparisonResult) -> String {
    let mut out = String::new();

    out.push_str("## Heap Comparison\n\n");
    out.push_str(&format!("- **Baseline:** {}\n", result.baseline_path));
    out.push_str(&format!("- **Current:** {}\n\n", result.current_path));

    // Summary delta
    let sd = &result.summary_delta;
    out.push_str("### Summary Delta\n\n");
    out.push_str("| Metric | Baseline | Current | Delta |\n");
    out.push_str("|--------|----------|---------|-------|\n");
    out.push_str(&format!("| Total Heap | {} | {} | {} |\n",
        fmt_bytes(sd.baseline_total_heap_size), fmt_bytes(sd.current_total_heap_size),
        fmt_delta_bytes(sd.total_heap_size_delta)));
    out.push_str(&format!("| Reachable | {} | {} | {} |\n",
        fmt_bytes(sd.baseline_reachable_heap_size), fmt_bytes(sd.current_reachable_heap_size),
        fmt_delta_bytes(sd.reachable_heap_size_delta)));
    out.push_str(&format!("| Instances | {} | {} | {:+} |\n",
        sd.baseline_total_instances, sd.current_total_instances, sd.total_instances_delta));
    out.push_str(&format!("| Classes | {} | {} | {:+} |\n",
        sd.baseline_total_classes, sd.current_total_classes, sd.total_classes_delta));
    out.push_str(&format!("| Arrays | {} | {} | {:+} |\n",
        sd.baseline_total_arrays, sd.current_total_arrays, sd.total_arrays_delta));
    out.push_str(&format!("| GC Roots | {} | {} | {:+} |\n\n",
        sd.baseline_total_gc_roots, sd.current_total_gc_roots, sd.total_gc_roots_delta));

    // Top 20 class changes
    let hist_count = result.histogram_delta.len().min(20);
    if hist_count > 0 {
        out.push_str(&format!("### Top {} Class Changes (by retained size delta)\n\n", hist_count));
        out.push_str("| # | Class | Change | Instances | Retained Delta | Baseline Ret. | Current Ret. |\n");
        out.push_str("|---|-------|--------|-----------|----------------|---------------|-------------|\n");
        for (i, d) in result.histogram_delta.iter().take(hist_count).enumerate() {
            out.push_str(&format!("| {} | {} | {} | {:+} | {} | {} | {} |\n",
                i + 1, d.class_name, d.change_type, d.instance_count_delta,
                fmt_delta_bytes(d.retained_size_delta),
                fmt_bytes(d.baseline_retained_size), fmt_bytes(d.current_retained_size)));
        }
        out.push('\n');
    }

    // Leak suspect changes
    if !result.leak_suspect_changes.is_empty() {
        out.push_str("### Leak Suspect Changes\n\n");
        for lsc in &result.leak_suspect_changes {
            let icon = match lsc.change_type.as_str() {
                "new" => "NEW",
                "resolved" => "RESOLVED",
                _ => "PERSISTED",
            };
            out.push_str(&format!("- **[{}] {}** — {}\n", icon, lsc.class_name, lsc.description));
            if lsc.change_type == "persisted" {
                out.push_str(&format!("  Retained: {} -> {} ({})\n",
                    fmt_bytes(lsc.baseline_retained_size), fmt_bytes(lsc.current_retained_size),
                    fmt_delta_bytes(lsc.retained_size_delta)));
            }
        }
        out.push('\n');
    }

    // Waste delta
    let wd = &result.waste_delta;
    out.push_str("### Waste Delta\n\n");
    out.push_str(&format!("- **Total Waste:** {} -> {} ({})\n",
        fmt_bytes(wd.baseline_total_wasted_bytes), fmt_bytes(wd.current_total_wasted_bytes),
        fmt_delta_bytes(wd.total_wasted_delta)));
    out.push_str(&format!("- **Waste %:** {:.1}% -> {:.1}% ({:+.1}pp)\n",
        wd.baseline_waste_percentage, wd.current_waste_percentage, wd.waste_percentage_delta));
    out.push_str(&format!("- **Duplicate Strings Delta:** {}\n",
        fmt_delta_bytes(wd.duplicate_string_wasted_delta)));
    out.push_str(&format!("- **Empty Collections Delta:** {}\n",
        fmt_delta_bytes(wd.empty_collection_wasted_delta)));

    out
}

/// Formats a JSON value for display.
fn format_json_value(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                format!("{:.2}", f)
            } else {
                n.to_string()
            }
        }
        serde_json::Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// Makes an MCP tool result content block.
fn mcp_text_result(text: &str, is_error: bool) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}

/// Handles an MCP tools/call request.
fn handle_mcp_tool_call(
    tool_name: &str,
    arguments: &serde_json::Value,
    analysis_states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> serde_json::Value {
    match tool_name {
        "analyze_heap" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };

            eprintln!("[MCP] analyze_heap: {}", path);
            let no_cancel = Arc::new(AtomicBool::new(false));
            match analyze_heap_internal(&PathBuf::from(path), analysis_states.clone(), &no_cancel) {
                Ok((top_objects, state, _timing)) => {
                    let text = format_analyze_result(&state, &top_objects);
                    mcp_text_result(&text, false)
                }
                Err(e) => {
                    mcp_text_result(&format!("Analysis failed: {}", e), true)
                }
            }
        }
        "get_leak_suspects" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => mcp_text_result(&format_leak_suspects(&state.leak_suspects), false),
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "get_class_histogram" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            let limit = arguments.get("limit").and_then(|v| v.as_u64()).unwrap_or(30) as usize;
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => mcp_text_result(&format_class_histogram(&state.class_histogram, limit), false),
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "drill_down" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            let object_id = match arguments.get("object_id").and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => return mcp_text_result("Missing required parameter: object_id", true),
            };
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => {
                    let children = state.get_children(object_id).unwrap_or_default();
                    mcp_text_result(&format_children(&children, object_id), false)
                }
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "get_summary" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => mcp_text_result(&format_summary(&state.summary), false),
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "get_waste_analysis" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => mcp_text_result(&format_waste_analysis(&state.waste_analysis), false),
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "execute_heapql" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            let query = match arguments.get("query").and_then(|v| v.as_str()) {
                Some(q) => q,
                None => return mcp_text_result("Missing required parameter: query", true),
            };
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => {
                    match state.execute_query(query) {
                        Ok(result) => mcp_text_result(&format_query_result(&result), false),
                        Err(e) => mcp_text_result(&format!("Query error: {}", e), true),
                    }
                }
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "inspect_object" => {
            let path = match arguments.get("path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: path", true),
            };
            let object_id = match arguments.get("object_id").and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => return mcp_text_result("Missing required parameter: object_id", true),
            };
            match get_analysis_state_for_path(analysis_states, path) {
                Ok(state) => {
                    let hprof_path = std::path::Path::new(path);
                    match state.inspect_object(hprof_path, object_id) {
                        Some(fields) => mcp_text_result(&format_inspect_result(&fields), false),
                        None => mcp_text_result(&format!("Object 0x{:x} not found or is not an Instance", object_id), true),
                    }
                }
                Err(e) => mcp_text_result(&e, true),
            }
        }
        "compare_heaps" => {
            let current_path = match arguments.get("current_path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: current_path", true),
            };
            let baseline_path = match arguments.get("baseline_path").and_then(|v| v.as_str()) {
                Some(p) => p,
                None => return mcp_text_result("Missing required parameter: baseline_path", true),
            };
            let current_state = match get_analysis_state_for_path(analysis_states, current_path) {
                Ok(s) => s,
                Err(e) => return mcp_text_result(&format!("Current file: {}", e), true),
            };
            let baseline_state = match get_analysis_state_for_path(analysis_states, baseline_path) {
                Ok(s) => s,
                Err(e) => return mcp_text_result(&format!("Baseline file: {}", e), true),
            };
            let result = compare_heaps(&baseline_state, &current_state, baseline_path, current_path);
            mcp_text_result(&format_comparison_result(&result), false)
        }
        _ => {
            mcp_text_result(&format!("Unknown tool: {}", tool_name), true)
        }
    }
}

/// Runs the MCP server (synchronous stdin/stdout loop).
fn run_mcp_server() -> Result<()> {
    let analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>> =
        Arc::new(RwLock::new(HashMap::new()));

    let stdin = io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[MCP] Failed to read stdin: {}", e);
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                eprintln!("[MCP] Failed to parse request: {} (line: {})", e, line);
                continue;
            }
        };

        match request.method.as_str() {
            "initialize" => {
                if let Some(id) = &request.id {
                    let response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {
                                "tools": {}
                            },
                            "serverInfo": {
                                "name": "heaplens",
                                "version": "0.1.0"
                            }
                        }
                    });
                    send_stdout(&response)?;
                }
            }
            "notifications/initialized" | "initialized" => {
                // No-op notification, no response needed
            }
            "tools/list" => {
                if let Some(id) = &request.id {
                    let tools = mcp_tool_definitions();
                    let response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": tools
                    });
                    send_stdout(&response)?;
                }
            }
            "tools/call" => {
                if let Some(id) = &request.id {
                    let params = request.params.unwrap_or(serde_json::json!({}));
                    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let arguments = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));

                    let result = handle_mcp_tool_call(tool_name, &arguments, &analysis_states);

                    let response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": result
                    });
                    send_stdout(&response)?;
                }
            }
            _ => {
                // Unknown method
                if let Some(id) = &request.id {
                    let response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": format!("Method not found: {}", request.method)
                        }
                    });
                    send_stdout(&response)?;
                }
            }
        }
    }

    eprintln!("[MCP] Server shutdown");
    Ok(())
}

// ============================================================================
// JSON-RPC Server (existing extension mode)
// ============================================================================

/// Runs the JSON-RPC server for VS Code extension communication.
async fn run_jsonrpc_server() -> Result<()> {
    let (result_tx, mut result_rx) = mpsc::unbounded_channel::<AnalyzeHeapResult>();
    let request_id_counter = Arc::new(AtomicU64::new(1));
    let analysis_states: Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let cancel_tokens: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>> =
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

                // Handle analyze_heap requests
                if request.method == "analyze_heap" {
                    if let Err(e) = handle_analyze_heap_request(
                        request,
                        &result_tx,
                        &request_id_counter,
                        &analysis_states,
                        &cancel_tokens,
                    ).await {
                        eprintln!("Error handling request: {}", e);
                    }
                } else if request.method == "cancel_analysis" {
                    if let Err(e) = handle_cancel_analysis_request(
                        request,
                        &cancel_tokens,
                    ).await {
                        eprintln!("Error handling cancel_analysis request: {}", e);
                    }
                } else if request.method == "ping" {
                    if let Some(id) = request.id {
                        let response = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "status": "ok" }
                        });
                        if let Err(e) = send_stdout(&response) {
                            eprintln!("Failed to send ping response: {}", e);
                        }
                    }
                } else if request.method == "get_children" {
                    if let Err(e) = handle_get_children_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling get_children request: {}", e);
                    }
                } else if request.method == "get_referrers" {
                    if let Err(e) = handle_get_referrers_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling get_referrers request: {}", e);
                    }
                } else if request.method == "export_json" {
                    if let Err(e) = handle_export_json_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling export_json request: {}", e);
                    }
                } else if request.method == "gc_root_path" {
                    if let Err(e) = handle_gc_root_path_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling gc_root_path request: {}", e);
                    }
                } else if request.method == "inspect_object" {
                    if let Err(e) = handle_inspect_object_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling inspect_object request: {}", e);
                    }
                } else if request.method == "execute_query" {
                    if let Err(e) = handle_execute_query_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling execute_query request: {}", e);
                    }
                } else if request.method == "list_analyzed_files" {
                    if let Err(e) = handle_list_analyzed_files_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling list_analyzed_files request: {}", e);
                    }
                } else if request.method == "compare_heaps" {
                    if let Err(e) = handle_compare_heaps_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling compare_heaps request: {}", e);
                    }
                } else if request.method == "get_dominator_subtree" {
                    if let Err(e) = handle_get_dominator_subtree_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling get_dominator_subtree request: {}", e);
                    }
                } else if request.method == "get_timeline_data" {
                    if let Err(e) = handle_get_timeline_data_request(
                        request,
                        &analysis_states,
                    ).await {
                        eprintln!("Error handling get_timeline_data request: {}", e);
                    }
                } else {
                    // Unknown method - send error response
                    if let Some(id) = request.id {
                        let error_response = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32601,
                                "message": format!("Method not found: {}", request.method)
                            }
                        });
                        if let Err(e) = send_stdout(&error_response) {
                            eprintln!("Failed to send error response: {}", e);
                            break;
                        }
                    }
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
    cancel_tokens: &Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
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
    {
        let mut tokens = cancel_tokens.write()
            .map_err(|e| anyhow::anyhow!("Failed to write cancel tokens: {}", e))?;
        tokens.insert(path_key.clone(), cancel_token.clone());
    }

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

    // Spawn blocking task for CPU-intensive work
    task::spawn_blocking(move || {
        let result = analyze_heap_blocking(path_buf, request_id, analysis_states, cancel_token);

        // Clean up cancel token
        if let Ok(mut tokens) = cancel_tokens_cleanup.write() {
            tokens.remove(&path_key);
        }

        // Send result via channel (non-blocking)
        if let Err(e) = result_tx.send(result) {
            eprintln!("Failed to send analysis result: {}", e);
        }
    });

    Ok(())
}

/// Handles a cancel_analysis request.
async fn handle_cancel_analysis_request(
    request: JsonRpcRequest,
    cancel_tokens: &Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
) -> Result<()> {
    let params = request.params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'path' parameter"))?;

    let request_id = request.id.ok_or_else(|| anyhow::anyhow!("Request ID required"))?;

    let cancelled = if let Ok(tokens) = cancel_tokens.read() {
        if let Some(token) = tokens.get(path) {
            token.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    } else {
        false
    };

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "cancelled": cancelled }
    });
    send_stdout(&response)?;

    // Send cancelled progress notification
    if cancelled {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "heap_analysis_progress",
            "params": {
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
        "summary": analysis_state.summary,
        "class_histogram": analysis_state.class_histogram,
        "leak_suspects": analysis_state.leak_suspects,
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

    let analysis_states_guard = analysis_states.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis states: {}", e))?;

    let file_state = analysis_states_guard.get(&PathBuf::from(path))
        .ok_or_else(|| anyhow::anyhow!("No analysis found for file: {}", path))?;

    let state_guard = file_state.state.read()
        .map_err(|e| anyhow::anyhow!("Failed to read analysis state: {}", e))?;

    let analysis_state = state_guard.as_ref()
        .ok_or_else(|| anyhow::anyhow!("Analysis state not available"))?;

    // Use cached mmap if available, otherwise fall back to path-based re-mapping
    let fields = if let Some(ref cached_mmap) = file_state.mmap {
        analysis_state.inspect_object_bytes(&cached_mmap[..], object_id)
    } else {
        let hprof_path = std::path::Path::new(path);
        analysis_state.inspect_object(hprof_path, object_id)
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

    let result = compare_heaps(&baseline_state, &current_state, baseline_path, current_path);

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

    if cli.mcp {
        log::info!("Starting HeapLens MCP server");
        run_mcp_server()
    } else {
        log::info!("Starting HPROF analysis server (JSON-RPC mode)");
        run_jsonrpc_server().await
    }
}
