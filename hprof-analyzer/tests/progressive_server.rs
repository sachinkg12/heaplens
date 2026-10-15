//! Real stdio protocol checks; no IDE, external AI, or production dump is used.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Server {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
    pending: Vec<Value>,
}
impl Server {
    fn new() -> Self {
        Self::configured(&[])
    }
    fn configured(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hprof-server"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if let Ok(line) = line {
                    if let Ok(v) = serde_json::from_str(&line) {
                        if tx.send(v).is_err() {
                            break;
                        }
                    }
                } else {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            pending: vec![],
        }
    }
    fn send(&mut self, v: Value) {
        writeln!(self.input, "{v}").unwrap();
        self.input.flush().unwrap();
    }
    fn wait(&mut self, condition: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self.pending.iter().position(&condition) {
            return self.pending.remove(i);
        }
        loop {
            let v = self
                .output
                .recv_timeout(Duration::from_secs(10))
                .expect("server response timeout");
            if condition(&v) {
                return v;
            }
            self.pending.push(v);
        }
    }
    fn ack(&mut self, id: u64) -> Value {
        self.wait(|v| v["id"] == id)
    }
    fn complete(&mut self, id: u64, method: &str) -> Value {
        self.wait(|v| v["method"] == method && v["params"]["request_id"] == id)["params"].clone()
    }
}

#[test]
fn stdio_hosts_use_disk_indices_across_server_restarts_and_keep_waste_lazy() {
    let dir=tempfile::tempdir().unwrap(); let heap=dir.path().join("disk.hprof"); let cache=dir.path().join("cache"); std::fs::write(&heap,fixture(1)).unwrap();
    for status in ["built","reused"] {
        let mut server=Server::configured(&["--storage","disk","--cache-dir",cache.to_str().unwrap(),"--edge-buffer-mib","1"]);
        server.send(req(1,"scan_heap",&heap));server.ack(1); assert_eq!(server.complete(1,"heap_scan_complete")["analysis_scope"],"shallow");
        server.send(req(2,"analyze_heap",&heap));server.ack(2);let full=server.complete(2,"heap_analysis_complete");
        assert_eq!(full["status"],"completed");assert_eq!(full["storage"]["mode"],"disk");assert_eq!(full["storage"]["cache_status"],status);assert!(full["waste_analysis"].is_null());
        let mut query=req(3,"execute_query",&heap);query["params"]["query"]=json!("SELECT object_id FROM instances LIMIT 1"); server.send(query);assert!(server.ack(3)["result"]["rows"].is_array());
        server.send(req(4,"get_waste_analysis",&heap));assert_eq!(server.ack(4)["result"]["total_wasted_bytes"],0);
    }
}

#[test]
fn disk_verification_cancel_then_retry_preserves_protocol_and_cache_state() {
    use std::io::{Seek, SeekFrom};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("buffer.hprof");
    let cache = dir.path().join("cache");
    let payload = 64 * 1024 * 1024u32;
    let mut header = b"JAVA PROFILE 1.0.2\0".to_vec();
    header.extend(4u32.to_be_bytes());
    header.extend(0u64.to_be_bytes());
    header.push(0x1c);
    header.extend(0u32.to_be_bytes());
    header.extend((5 + 14 + payload).to_be_bytes());
    header.push(0xff);
    header.extend(512u32.to_be_bytes());
    header.push(0x23);
    header.extend(512u32.to_be_bytes());
    header.extend(0u32.to_be_bytes());
    header.extend(payload.to_be_bytes());
    header.push(8);
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(&header).unwrap();
    let end = header.len() as u64 + payload as u64;
    file.set_len(end + 9).unwrap();
    file.seek(SeekFrom::Start(end)).unwrap();
    file.write_all(&[0x2c, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    drop(file);
    let mut server = Server::configured(&[
        "--storage", "disk", "--cache-dir", cache.to_str().unwrap(), "--edge-buffer-mib", "1"
    ]);
    let batch = [
        req(1, "analyze_heap", &path),
        json!({"jsonrpc":"2.0","id":2,"method":"cancel_analysis",
            "params":{"path":path,"analysis_request_id":1}})
    ].into_iter().map(|v| v.to_string() + "\n").collect::<String>();
    server.input.write_all(batch.as_bytes()).unwrap();
    server.input.flush().unwrap();
    assert_eq!(server.ack(1)["result"]["status"], "processing");
    assert_eq!(server.ack(2)["result"]["cancelled"], true);
    assert_eq!(server.complete(1, "heap_analysis_complete")["status"], "cancelled");
    assert!(!cache.exists() || std::fs::read_dir(&cache).unwrap().count() == 0);
    server.send(req(3, "analyze_heap", &path));
    server.ack(3);
    let complete = server.complete(3, "heap_analysis_complete");
    assert_eq!(complete["status"], "completed");
    assert_eq!(complete["storage"]["cache_status"], "built");
    assert!(complete["waste_analysis"].is_null());
    server.send(req(4, "analyze_heap", &path));
    server.ack(4);
    assert_eq!(server.complete(4, "heap_analysis_complete")["storage"]["cache_status"], "reused");
    let mut query = req(5, "execute_query", &path);
    query["params"]["query"] = json!("SELECT object_id FROM instances LIMIT 1");
    server.send(query);
    assert_eq!(server.ack(5)["result"]["rows"].as_array().unwrap().len(), 1);
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn fixture(count: usize) -> Vec<u8> {
    let mut data = b"JAVA PROFILE 1.0.2\0".to_vec();
    data.extend(4u32.to_be_bytes());
    data.extend(0u64.to_be_bytes());
    let array = [0x23, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8];
    // Readiness queries exercise a live object, not an unrooted garbage-only dump.
    let mut heap = Vec::new();
    if count != 0 { heap.push(0xff); heap.extend(512u32.to_be_bytes()); }
    heap.extend(array.repeat(count));
    data.push(0x1c);
    data.extend(0u32.to_be_bytes());
    data.extend((heap.len() as u32).to_be_bytes());
    data.extend(heap);
    data.push(0x2c);
    data.extend([0u8; 8]);
    data
}
fn req(id: u64, method: &str, path: &std::path::Path) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":{"path":path}})
}

#[test]
fn scan_cannot_implicitly_query_and_explicit_full_analysis_restores_readiness() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.hprof");
    std::fs::write(&path, fixture(1)).unwrap();
    let mut server = Server::new();
    server.send(req(1, "scan_heap", &path));
    assert_eq!(server.ack(1)["result"]["analysis_scope"], "shallow");
    let scan = server.complete(1, "heap_scan_complete");
    assert_eq!(scan["status"], "completed");
    assert!(scan["summary"]["reachable_heap_size"].is_null());
    assert!(scan["class_histogram"][0].get("retained_size").is_none());
    assert!(scan.get("waste_analysis").is_none());
    for (i, method) in [
        "execute_query",
        "get_children",
        "get_referrers",
        "gc_root_path",
        "inspect_object",
        "export_json",
        "get_dominator_subtree",
        "get_waste_analysis",
    ]
    .iter()
    .enumerate()
    {
        let id = 10 + i as u64;
        server.send(req(id, method, &path));
        assert_eq!(server.ack(id)["error"]["code"], -32002);
    }
    server.send(json!({"jsonrpc":"2.0","id":20,"method":"list_analyzed_files"}));
    assert_eq!(server.ack(20)["result"], json!([]));
    server.send(req(21, "analyze_heap", &path));
    server.ack(21);
    let full = server.complete(21, "heap_analysis_complete");
    assert_eq!(full["status"], "completed");
    assert_eq!(
        scan["summary"]["total_heap_size"],
        full["summary"]["total_heap_size"]
    );
    let mut query = req(22, "execute_query", &path);
    query["params"]["query"] = json!("SELECT * FROM instances LIMIT 1");
    server.send(query.clone());
    assert_eq!(
        server.ack(22)["result"]["rows"].as_array().unwrap().len(),
        1
    );
    server.send(req(23, "scan_heap", &path));
    server.ack(23);
    server.complete(23, "heap_scan_complete");
    query["id"] = json!(24);
    server.send(query);
    assert_eq!(server.ack(24)["error"]["code"], -32002);
}

#[test]
fn full_completion_omits_waste_until_explicit_request_and_query_remains_available() {
    let dir=tempfile::tempdir().unwrap();
    let path=dir.path().join("content.hprof");
    std::fs::write(&path,fixture(1)).unwrap();
    let mut server=Server::new();
    server.send(req(1,"get_waste_analysis",&path));
    assert_eq!(server.ack(1)["error"]["code"],-32002);
    server.send(req(2,"analyze_heap",&path));server.ack(2);
    let full=server.complete(2,"heap_analysis_complete");
    assert_eq!(full["status"],"completed");
    assert!(full["waste_analysis"].is_null());
    server.send(req(3,"get_waste_analysis",&path));
    let first=server.ack(3)["result"].clone();
    assert_eq!(first["total_wasted_bytes"],0);
    server.send(req(4,"get_waste_analysis",&path));
    assert_eq!(server.ack(4)["result"],first);
    let mut query=req(5,"execute_query",&path);
    query["params"]["query"]=json!("SELECT object_id FROM instances LIMIT 1");
    server.send(query);assert!(server.ack(5)["result"]["rows"].is_array());
}
#[test]
fn active_scan_rejects_overlap_and_only_matching_cancel_terminates_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.hprof");
    std::fs::write(&path, fixture(400_000)).unwrap();
    let mut server = Server::new();
    // One write ensures the async request loop sees the overlap/cancel before CPU work finishes.
    let batch = [
        req(1, "scan_heap", &path),
        req(2, "analyze_heap", &path),
        json!({"jsonrpc":"2.0","id":3,"method":"cancel_analysis","params":{"path":path,"analysis_request_id":999}}),
        json!({"jsonrpc":"2.0","id":4,"method":"cancel_analysis","params":{"path":path,"analysis_request_id":1}}),
    ];
    let text = batch
        .into_iter()
        .map(|v| v.to_string() + "\n")
        .collect::<String>();
    server.input.write_all(text.as_bytes()).unwrap();
    server.input.flush().unwrap();
    assert_eq!(server.ack(1)["result"]["status"], "processing");
    assert_eq!(server.ack(2)["error"]["code"], -32001);
    assert_eq!(server.ack(3)["result"]["cancelled"], false);
    assert_eq!(server.ack(4)["result"]["cancelled"], true);
    assert_eq!(
        server.complete(1, "heap_scan_complete")["status"],
        "cancelled"
    );
    server.send(req(5, "scan_heap", &path));
    server.ack(5);
    let scan = server.complete(5, "heap_scan_complete");
    assert_eq!(scan["status"], "completed");
    assert_eq!(scan["summary"]["total_arrays"], 400_000);
}
#[test]
fn malformed_and_unsupported_scans_fail_closed_with_sanitized_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private-canary.hprof");
    let mut server = Server::new();
    for (id, bytes) in [
        (1, b"private-canary".to_vec()),
        (2, {
            let mut b = fixture(1);
            b[16] = b'3';
            b
        }),
    ] {
        std::fs::write(&path, bytes).unwrap();
        server.send(req(id, "scan_heap", &path));
        server.ack(id);
        let result = server.complete(id, "heap_scan_complete");
        assert_eq!(result["status"], "error");
        assert!(!result.to_string().contains("private-canary"));
        assert!(result.get("summary").is_none());
    }
}
