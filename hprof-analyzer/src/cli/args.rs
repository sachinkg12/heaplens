use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Format {
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Backend {
    Indexed,
    Legacy,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Self::Indexed => "indexed",
            Self::Legacy => "legacy",
        }
    }
}

#[derive(Parser)]
#[command(
    name = "heaplens",
    version,
    about = "Local Java heap analysis without an IDE or an LLM"
)]
pub struct Args {
    #[command(subcommand)]
    pub command: Command,
    /// Output representation. JSON schema version 1 uses integer byte counts.
    #[arg(long, global = true, value_enum, default_value = "text")]
    pub format: Format,
    /// Analysis backend; both reuse the shared analyzer library.
    #[arg(long, global = true, value_enum, default_value = "indexed")]
    pub backend: Backend,
    /// Reference storage: memory (default) or private reusable disk indices.
    #[arg(long, global = true, value_parser = ["memory", "disk"])]
    pub storage: Option<String>,
    /// Private absolute index directory; used only by disk mode.
    #[arg(long, global = true)]
    pub cache_dir: Option<PathBuf>,
    /// Disk edge-sort buffer in MiB (not a total RAM/RSS limit).
    #[arg(long, global = true, value_parser = clap::value_parser!(u64).range(1..=1024))]
    pub edge_buffer_mib: Option<u64>,
    /// Maximum rows per report section or query page (not an analysis memory budget).
    #[arg(long, global = true, default_value_t = 100, value_parser = clap::value_parser!(u64).range(1..=10_000))]
    pub rows: u64,
    /// Write to a NEW file instead of stdout. Existing files are never overwritten.
    #[arg(long, global = true)]
    pub output: Option<PathBuf>,
    /// Suppress progress on stderr, but not errors.
    #[arg(long, global = true)]
    pub quiet: bool,
    /// Azure diagnostics are on by default (all). Use off to disable; error sends failures only. No dump/source/query text or stable IDs.
    #[arg(long, global = true, value_enum, default_value = "all")]
    pub telemetry: TelemetryLevel,
    /// Save recent allowlisted diagnostic records locally to a NEW file; never auto-upload this file.
    #[arg(long, global = true)]
    pub diagnostics: Option<PathBuf>,
}

impl Args {
    pub fn storage_options(&self) -> anyhow::Result<hprof_analyzer::indexed::storage::StorageOptions> {
        use hprof_analyzer::indexed::storage::{StorageMode, StorageOptions};
        let mut options = StorageOptions::from_env()?;
        if let Some(mode) = &self.storage { options.mode = StorageMode::parse(mode)?; }
        if let Some(directory) = &self.cache_dir { options.cache_dir = Some(directory.clone()); }
        if let Some(mib) = self.edge_buffer_mib { options.set_buffer_mib(mib as usize)?; }
        anyhow::ensure!(!matches!(self.backend, Backend::Legacy) || options.mode == StorageMode::Memory, "Disk storage requires the indexed backend");
        Ok(options)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum TelemetryLevel {
    Off,
    Error,
    All,
}
impl TelemetryLevel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Error => "error",
            Self::All => "all",
        }
    }
    pub fn effective(self) -> Self {
        if std::env::var_os("CI").is_some() || std::env::var("DO_NOT_TRACK").as_deref() == Ok("1") {
            Self::Off
        } else {
            self
        }
    }
}

#[derive(Subcommand)]
pub enum Command {
    /// Open the shared eleven-tab UI in a local browser (Node host required).
    Open {
        /// One to eight local dumps; switching tabs does not reassign object IDs.
        #[arg(required = true, num_args = 1..=8)]
        hprof: Vec<PathBuf>,
        /// Approved source folders for local Java navigation and AI proposals.
        #[arg(long)]
        source_root: Vec<PathBuf>,
        /// Explicit trusted hprof-server binary (default: next to this executable).
        #[arg(long)]
        server: Option<PathBuf>,
        /// Node executable; default resolves `node` through PATH.
        #[arg(long)]
        node: Option<PathBuf>,
        /// Explicit installed browser-ui/server.cjs host script.
        #[arg(long)]
        ui_host: Option<PathBuf>,
        /// Print the private launch URL without opening a browser.
        #[arg(long)]
        no_browser: bool,
        /// Start with shallow totals only; Analyze Retained explicitly starts full analysis.
        #[arg(long)]
        quick_scan: bool,
        /// Loopback port; zero selects a free port. Never binds externally.
        #[arg(long, default_value_t = 0)]
        port: u16,
    },
    /// Structural analysis: summary, top objects, histograms and suspects.
    Analyze {
        hprof: PathBuf,
        /// Also calculate content-based Waste; omitted results are not zero.
        #[arg(long)]
        with_waste: bool,
    },
    /// Shallow summary and histogram only; no object index, references or dominators.
    Scan { hprof: PathBuf },
    /// Read-only HeapQL, including :path, :refs, :children and :info.
    Query {
        hprof: PathBuf,
        /// Quote the entire query as one shell argument. Never executed as shell code.
        query: String,
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u64).range(1..=1_000_000))]
        page: u64,
    },
    /// Compare baseline -> current; only one full heap graph is kept at a time.
    Compare { baseline: PathBuf, current: PathBuf },
}

impl Command {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Open { .. } => "open",
            Self::Analyze { .. } => "analyze",
            Self::Scan { .. } => "scan",
            Self::Query { .. } => "query",
            Self::Compare { .. } => "compare",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_defaults_to_all_and_explicit_off_is_preserved() {
        let args = Args::try_parse_from(["heaplens", "analyze", "fixture.hprof"]).unwrap();
        assert_eq!(args.telemetry, TelemetryLevel::All);
        for command in ["analyze", "open"] {
            let args =
                Args::try_parse_from(["heaplens", command, "fixture.hprof", "--telemetry", "off"])
                    .unwrap();
            assert_eq!(args.telemetry, TelemetryLevel::Off);
        }
        let args = Args::try_parse_from([
            "heaplens",
            "analyze",
            "fixture.hprof",
            "--telemetry",
            "error",
        ])
        .unwrap();
        assert_eq!(args.telemetry, TelemetryLevel::Error);
    }
}
