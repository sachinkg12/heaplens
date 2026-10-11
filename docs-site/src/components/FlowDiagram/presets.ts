export type FlowKind = 'architecture' | 'analysis' | 'ai' | 'source' | 'recovery';
export const flows: Record<FlowKind, {title: string; steps: {title: string; detail: string}[]; note: string}> = {
  architecture: {title: 'From local heap to investigation', steps: [
    {title: 'Local .hprof', detail: 'Completed, immutable snapshot'},
    {title: 'Shared Rust engine', detail: 'Parse · reference graph · dominators'},
    {title: 'Analysis results', detail: 'Metrics · objects · paths'},
  ], note: 'The host adapters are alternatives. Terminal commands also use the engine without a browser.'},
  analysis: {title: 'How a snapshot becomes evidence', steps: [
    {title: 'Read records', detail: 'Map the file and decode layouts'},
    {title: 'Build references', detail: 'Objects, roots, retaining edges'},
    {title: 'Compute ownership', detail: 'Dominators and modeled sizes'},
    {title: 'Investigate', detail: 'Queries, fields, and root paths'},
  ], note: 'On-demand UI expansion does not make the initial graph analysis lazy.'},
  ai: {title: 'Optional AI has a separate boundary', steps: [
    {title: 'Choose an action', detail: 'Chat, Explain, or Fix with AI'},
    {title: 'Review what is shared', detail: 'Metadata; full source only if approved'},
    {title: 'Configured provider', detail: 'Local endpoints can forward remotely'},
    {title: 'Review the response', detail: 'Hypotheses or a proposal—not a verdict'},
  ], note: 'This is an editor/browser workflow. MCP clients have a separate raw-tool-output policy.'},
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
