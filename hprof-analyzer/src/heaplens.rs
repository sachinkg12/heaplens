//! One-shot local adapter. The IDE/MCP server remains a separate executable.
#[path = "cli/mod.rs"]
mod cli;

fn main() -> std::process::ExitCode {
    cli::main()
}
