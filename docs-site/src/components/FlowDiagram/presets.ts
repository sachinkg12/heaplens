export type FlowKind = 'architecture' | 'analysis' | 'storage' | 'ai' | 'source' | 'recovery';
export const flows: Record<FlowKind, {title: string; steps: {title: string; detail: string}[]; note: string}> = {
  architecture: {title: 'From local heap to investigation', steps: [
    {title: 'Local .hprof', detail: 'Completed, immutable snapshot'},
    {title: 'Shared Rust engine', detail: 'Quick Scan or full graph analysis'},
    {title: 'Staged results', detail: 'Shallow first · retained when ready'},
  ], note: 'Host adapters are alternatives. Memory is the default; optional Disk mode reuses verified structures. Terminal commands can run without a browser.'},
  analysis: {title: 'Fresh analysis with staged results', steps: [
    {title: 'Read records', detail: 'Map the capture · partial record counts'},
    {title: 'Show shallow results', detail: 'Overview and Histogram · retained unavailable'},
    {title: 'Build references', detail: 'Retaining edges · Memory or Disk storage'},
    {title: 'Show retained results', detail: 'Dominators · suspects · object actions'},
  ], note: 'Full analysis continues after shallow results. Quick Scan stops before graph work until Analyze Retained is chosen. Waste is a separate request after full analysis.'},
  storage: {title: 'Disk first build and verified reopening', steps: [
    {title: 'Identify the capture', detail: 'Read the complete input fingerprint'},
    {title: 'Build or reuse', detail: 'Versioned index · validate every component'},
    {title: 'Read mapped structures', detail: 'Nodes · CSR references · body/array catalogs'},
    {title: 'Compute retained results', detail: 'Recompute dominators and summaries'},
  ], note: 'Only structural data is reused, not completed dominator results. Keep the original capture. Indexes persist locally, contain sensitive metadata and are not encrypted. Mapped data still uses RAM.'},
  ai: {title: 'Optional AI has a separate boundary', steps: [
    {title: 'Choose an action', detail: 'Chat, Explain, or Fix with AI'},
    {title: 'Review what is shared', detail: 'Metadata; full source only if approved'},
    {title: 'Configured provider', detail: 'Local endpoints can forward remotely'},
    {title: 'Review the response', detail: 'Hypotheses or a proposal—not a verdict'},
  ], note: 'This is an editor/browser workflow. Scoped MCP clients require separate exact-file and metadata approval.'},
  source: {title: 'From owner class to a reviewed proposal', steps: [
    {title: 'Select class', detail: 'Heap identity is not source identity'},
    {title: 'Host resolves source', detail: 'Workspace, project, or supplied roots'},
    {title: 'Approve full file', detail: 'Check source and actual destination'},
    {title: 'Review and test', detail: 'Explicit apply; host-specific Undo'},
  ], note: 'Opening a memory owner does not prove it is the correct repair location.'},
  recovery: {title: 'Recover one dump without replacing the others', steps: [
    {title: 'Process exits', detail: 'Different from a slow analysis'},
    {title: 'Show Retry', detail: 'Keep failure visible in that editor'},
    {title: 'Start replacement', detail: 'Fresh server and request routing'},
    {title: 'Analyze again', detail: 'Retired messages cannot replace new state'},
  ], note: 'Successful recovery does not explain the original exit or guarantee immunity from memory pressure.'},
};
