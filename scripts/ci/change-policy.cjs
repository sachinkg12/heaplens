// Pure routing policy. Unknown paths run all checks, but never authorize a release.
const all = {vscode:true, intellij:true, rust:true};
const rules = [
  [/^telemetry\//, {...all,release:true}],
  [/^browser-ui\//, all], // Standalone checks, never a release permission.
  [/^intellij-plugin\//, {intellij:true}],
  [/^(?:\.github\/|scripts\/ci\/)/, all],
  [/^(?:docs-site\/|docs\/|papers\/|media\/screenshots\/)|\.md$/i, {}],
  [/^(?:src\/webview\/|media\/d3\.v7\.min\.js$|package(?:-lock)?\.json$)/, {vscode:true,intellij:true,release:true}],
  [/^(?:hprof-analyzer\/|bin\/)/, {...all,release:true}],
  [/^(?:src\/|media\/|icon\.(?:png|svg)$|tsconfig\.json$|\.eslintrc\.json$|\.vscodeignore$|scripts\/package-binary\.sh$)/, {vscode:true,release:true}]
];
function planChanges(paths, {eventName, ref, message = ''}) {
  const plan = {vscode:false,intellij:false,rust:false,auto_release:false,publish_vscode:false};
  let releaseRelevant = false;
  for (const file of paths) {
    const rule = rules.find(([pattern]) => pattern.test(file));
    const selected = rule ? rule[1] : all;
    for (const key of ['vscode','intellij','rust']) plan[key] ||= selected[key] === true;
    releaseRelevant ||= selected.release === true;
  }
  // Keep the existing stable vMAJOR.MINOR.PATCH namespace exclusive to VS Code.
  if (eventName === 'push' && /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref)) {
    Object.assign(plan, all, {publish_vscode:true});
  } else if (eventName === 'push' && ref.startsWith('refs/tags/intellij-v')) {
    Object.assign(plan, {vscode:false,intellij:true,rust:false});
    // IntelliJ tags validate only. No IntelliJ publishing exists in the prototype.
  } else if (eventName === 'push' && ref.startsWith('refs/tags/')) {
    Object.assign(plan, all); // Unrecognized tags cannot publish.
  }
  plan.auto_release = eventName === 'push' && ref === 'refs/heads/main' &&
    releaseRelevant && !message.startsWith('chore(release)');
  return plan;
}
module.exports = {planChanges};
