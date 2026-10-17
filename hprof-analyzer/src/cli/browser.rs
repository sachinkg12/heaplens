use super::{
    args::{Args, Backend, Command, Format},
    Failure,
};
use std::{path::PathBuf, process::Command as Process};

/// Additive host adapter: the standalone interactive UI uses the unchanged server
/// protocol. The one-shot CLI continues to call the analyzer library directly.
pub fn open(args: &Args) -> Result<(), Failure> {
    let Command::Open {
        hprof,
        source_root,
        server,
        node,
        ui_host,
        no_browser,
        quick_scan,
        port,
    } = &args.command
    else {
        unreachable!()
    };
    if args.output.is_some() || matches!(args.format, Format::Json) || source_root.len() > 16 {
        return Err(Failure::new(2, "interactive_options", "Browser mode does not use --output or --format json; at most 16 source roots are allowed."));
    }
    let unavailable = || {
        Failure::new(3, "browser_unavailable", "Cannot launch browser host. Build browser-ui assets; install Node; check host/server/dump paths. No IDE is required.")
    };
    let executable = std::env::current_exe().map_err(|_| unavailable())?;
    let server = server.clone().unwrap_or_else(|| {
        executable.with_file_name(if cfg!(windows) {
            "hprof-server.exe"
        } else {
            "hprof-server"
        })
    });
    let host = ui_host.clone().unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../browser-ui/server.cjs")
    });
    if !server.is_file()
        || !host.is_file()
        || hprof.iter().any(|p| !p.is_file())
        || source_root.iter().any(|p| !p.is_dir())
    {
        return Err(unavailable());
    }
    let mut command = Process::new(node.clone().unwrap_or_else(|| PathBuf::from("node")));
    let storage = args.storage_options().map_err(|_| Failure::new(2, "storage_options", "Invalid storage options; disk mode requires the indexed backend."))?;
    command.env("HEAPLENS_STORAGE", storage.mode.name()).env("HEAPLENS_EDGE_BUFFER_MIB", (storage.edge_buffer_bytes / (1024 * 1024)).to_string());
    if let Some(directory) = storage.cache_dir { command.env("HEAPLENS_CACHE_DIR", directory); }
    command
        .arg(host)
        .arg("--server")
        .arg(server)
        .arg("--port")
        .arg(port.to_string());
    command
        .arg("--telemetry")
        .arg(args.telemetry.effective().name());
    if matches!(args.backend, Backend::Legacy) {
        command.arg("--legacy");
    }
    if *no_browser {
        command.arg("--no-browser");
    }
    if *quick_scan { command.arg("--quick-scan"); }
    for root in source_root {
        command.arg("--source-root").arg(root);
    }
    for dump in hprof {
        command.arg("--dump").arg(dump);
    }
    let status = command.status().map_err(|_| unavailable())?;
    if status.success() {
        Ok(())
    } else {
        Err(unavailable())
    }
}
