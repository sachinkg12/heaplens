//! Bounded on-demand content analysis; never blocks the stdio dispatch loop.
use crate::{get_analysis_state_for_path, send_stdout, FileAnalysisState, JsonRpcRequest};
use anyhow::Result;
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, RwLock},
};

static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub(crate) fn start(
    request: JsonRpcRequest,
    states: &Arc<RwLock<HashMap<PathBuf, FileAnalysisState>>>,
) -> Result<()> {
    let Some(id) = request.id else {
        return Ok(());
    };
    let state = request
        .params
        .as_ref()
        .and_then(|p| p.get("path"))
        .and_then(|v| v.as_str())
        .and_then(|path| get_analysis_state_for_path(states, path).ok());
    let Some(state) = state else {
        return send_stdout(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Complete retained analysis before requesting Waste."}})).map_err(Into::into);
    };
    let Ok(permit) = WORKERS.try_acquire() else {
        return send_stdout(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32001,"message":"Waste analysis is busy. Retry shortly."}})).map_err(Into::into);
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            json!({"jsonrpc":"2.0","id":id,"result":state.get_waste_analysis()})
        })).unwrap_or_else(|_| json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Waste analysis failed. Retry or reopen the dump."}}));
        let _ = send_stdout(&response);
    });
    Ok(())
}
