//! On-demand content analysis, invoked only by the bounded read scheduler.
use crate::{get_analysis_state_for_path, send_stdout, FileAnalysisState, JsonRpcRequest};
use anyhow::Result;
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, RwLock},
};

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
    send_stdout(&json!({"jsonrpc":"2.0","id":id,"result":state.get_waste_analysis()})).map_err(Into::into)
}
