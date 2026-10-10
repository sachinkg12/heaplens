//! CLI-only delivery; the analyzer library and hprof-server never send telemetry.
use super::args::TelemetryLevel;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
const CONTRACT: &str = include_str!("../../../telemetry/contract.json");

pub struct Telemetry {
    schema: Value,
    context: Value,
    level: TelemetryLevel,
    recent: VecDeque<Value>,
    queue: Vec<Value>,
    phase: &'static str,
    start: Instant,
    metrics: Value,
}
impl Telemetry {
    pub fn new(level: TelemetryLevel) -> Self {
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            "linux" => "linux",
            _ => "unknown",
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            _ => "unknown",
        };
        Self {
            schema: serde_json::from_str(CONTRACT).expect("compiled telemetry contract"),
            context: json!({"schemaVersion":"1","host":"cli","version":env!("CARGO_PKG_VERSION"),"os":os,"arch":arch}),
            level: level.effective(),
            recent: VecDeque::new(),
            queue: Vec::new(),
            phase: "input",
            start: Instant::now(),
            metrics: json!({}),
        }
    }
    fn contains(values: &Value, value: &Value) -> bool {
        values.as_array().is_some_and(|a| a.contains(value))
    }
    pub fn record(&self, name: &str, properties: Value, measurements: Value) -> Option<Value> {
        let event = self.schema["events"].get(name)?;
        let mut props = self.context.as_object()?.clone();
        let mut metrics = serde_json::Map::new();
        for (key, value) in properties.as_object()? {
            if !Self::contains(&event["properties"], &json!(key))
                || !Self::contains(&self.schema["enums"][key], value)
            {
                return None;
            }
            props.insert(key.clone(), value.clone());
        }
        for (key, value) in measurements.as_object()? {
            if !Self::contains(&event["measurements"], &json!(key)) {
                return None;
            }
            let n = value.as_f64()?;
            let bounds = &self.schema["metrics"][key];
            let quantum = bounds["quantum"].as_f64()?;
            if !n.is_finite() || n < 0.0 || n > bounds["max"].as_f64()? {
                return None;
            }
            metrics.insert(
                key.clone(),
                json!((n / quantum).floor() as u64 * quantum as u64),
            );
        }
        Some(
            json!({"name":name,"category":event["category"],"properties":props,"measurements":metrics}),
        )
    }
    pub fn track(&mut self, name: &str, properties: Value, measurements: Value) {
        if let Some(event) = self.record(name, properties, measurements) {
            self.recent.push_back(event.clone());
            if self.recent.len() > 20 {
                self.recent.pop_front();
            }
            if self.queue.len() < 16
                && (self.level == TelemetryLevel::All
                    || self.level == TelemetryLevel::Error && event["category"] == "error")
            {
                self.queue.push(event);
            }
        }
    }
    pub fn phase(&mut self, phase: &'static str) {
        self.phase = phase;
        self.track("analysis/phase", json!({"phase":phase}), json!({}));
    }
    pub fn failed(&mut self, code: &str) {
        let kind = match code {
            "input_unavailable" => "not_found",
            "invalid_heap" => "parse",
            "invalid_query" | "query_length" => "parse",
            "browser_unavailable" => "server_spawn",
            _ => "unknown",
        };
        let name = if self.phase == "query" {
            "query/failed"
        } else {
            "analysis/failed"
        };
        self.track(
            name,
            json!({"errorType":kind,"phase":self.phase}),
            json!({}),
        );
    }
    pub fn summary(&mut self, summary: &hprof_analyzer::HeapSummary) {
        self.metrics = json!({"objectCount":summary.total_instances,"classCount":summary.total_classes,"heapSizeMB":summary.total_heap_size as f64/1048576.0});
    }
    pub fn completed(&mut self) {
        let mut metrics = self.metrics.clone();
        metrics["durationMs"] = json!((self.start.elapsed().as_millis() as u64).min(86400000));
        self.track("analysis/completed", json!({}), metrics);
    }
    pub fn level(&self) -> &'static str {
        self.level.name()
    }
    pub fn envelope(&self, event: &Value) -> Value {
        json!({"ver":1,"name":"Microsoft.ApplicationInsights.Event","time":chrono::Utc::now().to_rfc3339(),
        "iKey":self.schema["instrumentationKey"],"tags":{},"data":{"baseType":"EventData","baseData":{"ver":2,"name":format!("heaplens/{}",event["name"].as_str().unwrap_or("unknown")),"properties":event["properties"],"measurements":event["measurements"]}}})
    }
    pub fn report(&self) -> Value {
        json!({"schemaVersion":1,"level":self.level(),"events":self.recent,"note":"Local filtered records; no dump/source/query text or stable IDs. Network services may process IP addresses. No automatic support upload."})
    }
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(serde_json::to_string_pretty(&self.report())?.as_bytes())?;
        file.write_all(b"\n")
    }
    pub fn deliver_with(&mut self, send: impl FnOnce(&str, Vec<Value>)) {
        if self.queue.is_empty() {
            return;
        }
        let events = std::mem::take(&mut self.queue);
        let bodies = events.iter().map(|e| self.envelope(e)).collect();
        send(self.schema["endpoint"].as_str().unwrap_or(""), bodies);
    }
    pub fn deliver(&mut self) {
        self.deliver_with(|endpoint, bodies| {
            // One bounded batch after the command. No retries/redirects/proxy-derived authentication.
            if let Ok(client) = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(1))
                .connect_timeout(Duration::from_secs(1))
                .https_only(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
            {
                let _ = client.post(endpoint).json(&bodies).send();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forbidden_fields_and_values_are_rejected() {
        let t = Telemetry::new(TelemetryLevel::Off);
        for key in [
            "errorSummary",
            "path",
            "query",
            "source",
            "apiKey",
            "userId",
            "sessionId",
            "className",
        ] {
            assert!(t
                .record("analysis/failed", json!({key:"private-canary"}), json!({}))
                .is_none());
        }
        assert!(t
            .record(
                "analysis/failed",
                json!({"errorType":"private-canary"}),
                json!({})
            )
            .is_none());
        assert!(t
            .record("analysis/completed", json!({}), json!({"durationMs":-1}))
            .is_none());
        assert!(t
            .record(
                "analysis/completed",
                json!({}),
                json!({"durationMs":86400001})
            )
            .is_none());
    }
    #[test]
    fn final_body_has_no_identifiers_and_quantizes_metrics() {
        let t = Telemetry::new(TelemetryLevel::Off);
        let body = t.envelope(
            &t.record(
                "analysis/completed",
                json!({}),
                json!({"durationMs":1234,"heapSizeMB":95}),
            )
            .unwrap(),
        );
        assert_eq!(body["tags"], json!({}));
        assert_eq!(
            body["data"]["baseData"]["measurements"],
            json!({"durationMs":1200,"heapSizeMB":64})
        );
    }
    #[test]
    fn off_never_invokes_transport_and_local_report_is_sanitized() {
        let mut t = Telemetry::new(TelemetryLevel::Off);
        t.failed("private-canary");
        t.deliver_with(|_, _| panic!("No requests permitted"));
        assert!(!t.report().to_string().contains("private-canary"));
    }
    #[test]
    fn errors_only_excludes_usage_and_delivery_is_one_bounded_batch() {
        let mut t = Telemetry::new(TelemetryLevel::Off);
        t.level = TelemetryLevel::Error;
        t.track("analysis/started", json!({}), json!({}));
        for _ in 0..500 {
            t.failed("invalid_heap");
        }
        t.deliver_with(|endpoint, bodies| {
            assert!(endpoint.starts_with("https://"));
            assert_eq!(bodies.len(), 16);
            assert!(bodies
                .iter()
                .all(|b| b["data"]["baseData"]["name"] == "heaplens/analysis/failed"));
        });
        t.deliver_with(|_, _| panic!("Must not replay"));
    }
}
