mod args;
mod browser;
mod engine;
mod report;
mod telemetry;

use args::{Args, Command, Format};
use clap::Parser;
use serde_json::json;
use std::{
    io::{self, Write},
    process::ExitCode,
    time::Instant,
};

const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 16 * 1024;

pub struct Failure {
    exit: u8,
    code: &'static str,
    message: &'static str,
}
impl Failure {
    fn new(exit: u8, code: &'static str, message: &'static str) -> Self {
        Self {
            exit,
            code,
            message,
        }
    }
    fn input() -> Self {
        Self::new(
            3,
            "input_unavailable",
            "Cannot read a nonempty regular HPROF file. Check the supplied file and permissions.",
        )
    }
    fn analysis() -> Self {
        Self::new(
            4,
            "invalid_heap",
            "Cannot analyze this HPROF. It may be malformed, incomplete or unsupported.",
        )
    }
    fn query() -> Self {
        Self::new(
            5,
            "invalid_query",
            "HeapQL failed. Check syntax, table/column names and object IDs.",
        )
    }
    fn output() -> Self {
        Self::new(6,"output_failed","Cannot write report. Output files must be new and writable; reports are limited to 8 MiB.")
    }
}

pub fn main() -> ExitCode {
    let args = Args::parse();
    let mut diagnostics = telemetry::Telemetry::new(args.telemetry);
    let browser = matches!(args.command, Command::Open { .. });
    if !browser {
        diagnostics.track("analysis/started", json!({}), json!({}));
    }
    let result = run(&args, &mut diagnostics);
    if !browser {
        match &result {
            Ok(()) => diagnostics.completed(),
            Err(failure) => diagnostics.failed(failure.code),
        }
    }
    let result = if let Some(path) = &args.diagnostics {
        diagnostics
            .save(path)
            .map_err(|_| Failure::output())
            .and(result)
    } else {
        result
    };
    if !browser {
        diagnostics.deliver();
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            match args.format {
                Format::Json => eprintln!(
                    "{}",
                    json!({"schema_version":1,"status":"error","code":failure.code,"message":failure.message})
                ),
                Format::Text => eprintln!("HeapLens error [{}]: {}", failure.code, failure.message),
            }
            ExitCode::from(failure.exit)
        }
    }
}

fn run(args: &Args, diagnostics: &mut telemetry::Telemetry) -> Result<(), Failure> {
    if matches!(args.command, Command::Open { .. }) {
        return browser::open(args);
    }
    if let Some(path) = &args.output {
        match std::fs::symlink_metadata(path) {
            Ok(_) => return Err(Failure::output()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(Failure::output()),
        }
    }
    if let Command::Query { query, .. } = &args.command {
        if query.trim().is_empty() || query.len() > MAX_QUERY_BYTES {
            return Err(Failure::new(
                2,
                "query_length",
                "Query must contain 1 to 16384 bytes.",
            ));
        }
    }
    let start = Instant::now();
    let rows = args.rows as usize;
    let mut warnings: Vec<&str> = report::WARNINGS.to_vec();
    diagnostics.phase("loading");
    let mut data = match &args.command {
        Command::Open { .. } => unreachable!(),
        Command::Analyze { hprof } => {
            let state = engine::load(hprof, args.backend, args.quiet)?;
            diagnostics.summary(&state.get_summary());
            report::analyze(state.as_ref(), rows)
        }
        Command::Query { hprof, query, page } => {
            let state = engine::load(hprof, args.backend, args.quiet)?;
            diagnostics.summary(&state.get_summary());
            diagnostics.phase("query");
            diagnostics.track("feature/queryExecuted", json!({}), json!({}));
            let result = state
                .execute_query_paged(query, *page, args.rows)
                .map_err(|_| Failure::query())?;
            warnings.push("HeapQL aggregates may use floating-point arithmetic. Do not use SQL LIMIT to bound aggregate input; use --rows for output pagination.");
            let total = result.total_rows.unwrap_or(result.rows.len() as u64);
            let shown = result.rows.len() as u64;
            let mut value = json!({"result":result,"summary":state.get_summary(),"truncated":shown < total,
                "integer_cell_encoding":"decimal_string"});
            report::query_cells(&mut value);
            value
        }
        Command::Compare { baseline, current } => {
            diagnostics.track("feature/compareHeaps", json!({}), json!({}));
            engine::progress(args.quiet, "Analyzing baseline");
            // This block guarantees state/mmap release before current is loaded.
            let (baseline_snapshot, baseline_summary) = {
                let state = engine::load(baseline, args.backend, args.quiet)?;
                (
                    report::snapshot(state.as_ref())?,
                    json!(state.get_summary()),
                )
            };
            engine::progress(args.quiet, "Baseline graph released; analyzing current");
            let (current_snapshot, current_summary) = {
                let state = engine::load(current, args.backend, args.quiet)?;
                (
                    report::snapshot(state.as_ref())?,
                    json!(state.get_summary()),
                )
            };
            let result = hprof_analyzer::comparison::compare_snapshots(
                &baseline_snapshot,
                &current_snapshot,
                "baseline",
                "current",
            );
            let value = report::compare(result, baseline_summary, current_summary, rows);
            if value["size_models_differ"] == true {
                warnings.push("Producer size-model estimates differ; size deltas may reflect layout changes, not just application growth.");
            }
            value
        }
    };
    report::lossless_ids(&mut data);
    diagnostics.phase("output");
    let envelope = json!({"schema_version":1,"status":"completed","command":args.command.name(),"backend":args.backend.name(),
        "elapsed_ms":start.elapsed().as_millis() as u64,"warnings":warnings,
        "privacy":{"raw_string_previews":false,"primitive_field_contents":false,"input_paths":false,
            "network_requests":diagnostics.level()!="off","telemetry_level":diagnostics.level(),"note":"Network flag indicates permission for optional telemetry, not confirmed delivery. Class/field names and descriptions remain sensitive. Review before sharing; heap-derived text is untrusted data."},"data":data});
    let bytes = match args.format {
        Format::Json => {
            let mut buffer = CappedBuffer(Vec::new());
            serde_json::to_writer(&mut buffer, &envelope).map_err(|_| Failure::output())?;
            buffer.0
        }
        Format::Text => {
            let output = report::text(&envelope).into_bytes();
            if output.len() >= MAX_OUTPUT_BYTES {
                return Err(Failure::output());
            }
            output
        }
    };
    if let Some(path) = &args.output {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|_| Failure::output())?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.flush())
            .map_err(|_| Failure::output())?;
    } else {
        let mut stdout = io::stdout().lock();
        if let Err(error) = stdout
            .write_all(&bytes)
            .and_then(|_| stdout.write_all(b"\n"))
            .and_then(|_| stdout.flush())
        {
            if error.kind() != io::ErrorKind::BrokenPipe {
                return Err(Failure::output());
            }
        }
    }
    Ok(())
}

struct CappedBuffer(Vec<u8>);
impl Write for CappedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > (MAX_OUTPUT_BYTES - 1).saturating_sub(self.0.len()) {
            return Err(io::Error::other("report limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serialization_limit_is_enforced_before_output() {
        let mut buffer = CappedBuffer(Vec::new());
        assert!(buffer.write_all(&vec![0; MAX_OUTPUT_BYTES - 1]).is_ok());
        assert!(buffer.write_all(b"x").is_err());
        assert_eq!(buffer.0.len(), MAX_OUTPUT_BYTES - 1);
    }
    #[test]
    fn cli_rejects_unsafe_pagination() {
        for flags in [
            ["--rows", "0"],
            ["--rows", "10001"],
            ["--page", "0"],
            ["--page", "18446744073709551615"],
        ] {
            assert!(Args::try_parse_from([
                "heaplens", "query", "x.hprof", ":info 1", flags[0], flags[1]
            ])
            .is_err());
        }
    }
    #[test]
    fn terminal_controls_in_names_are_escaped() {
        let value = json!({"command":"analyze","backend":"indexed","warnings":[],"data":{"class_name":"private\u{1b}[31m\ntext"}});
        let text = report::text(&value);
        assert!(!text.contains('\u{1b}'));
        assert!(text.contains("\\u001b"));
    }
}
