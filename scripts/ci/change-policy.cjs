// Pure routing policy. Unknown paths run all checks, but never authorize a release.
const all = {vscode:true, intellij:true, rust:true};
const rules = [
  [/^telemetry\//, all],
  [/^browser-ui\//, all], // Standalone checks, never a release permission.
  [/^intellij-plugin\//, {intellij:true}],
  [/^(?:\.github\/|scripts\/ci\/)/, all],
  [/^src\/(?:promptTemplates|diagnosisPolicy|aiInvestigation|investigationEngine|llmClient)\.ts$/, {vscode:true,intellij:true}],
  [/^(?:docs-site\/|docs\/|papers\/|media\/screenshots\/)|\.md$/i, {}],
  [/^(?:src\/webview\/|media\/d3\.v7\.min\.js$|package(?:-lock)?\.json$)/, {vscode:true,intellij:true}],
  [/^(?:hprof-analyzer\/|bin\/)/, all],
  [/^(?:src\/|media\/|icon\.(?:png|svg)$|tsconfig\.json$|\.eslintrc\.json$|\.vscodeignore$|scripts\/package-binary\.sh$)/, {vscode:true}]
];
// Exact MAJOR.MINOR.PATCH tags publish. Prerelease or malformed tags only validate.
const SEMVER = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const STABLE_VSCODE = new RegExp('^refs/tags/v' + SEMVER + '$');
const INTELLIJ_RELEASE = new RegExp('^refs/tags/intellij-v' + SEMVER + '$');
function planChanges(paths, {eventName, ref}) {
  const plan = {vscode:false,intellij:false,rust:false,publish_vscode:false,publish_intellij:false};
  for (const file of paths) {
    const rule = rules.find(([pattern]) => pattern.test(file));
    const selected = rule ? rule[1] : all;
    for (const key of ['vscode','intellij','rust']) plan[key] ||= selected[key] === true;
  }
  const tag = eventName === 'push' && typeof ref === 'string' && ref.startsWith('refs/tags/');
  // Keep the existing stable vMAJOR.MINOR.PATCH namespace exclusive to VS Code.
  if (tag && STABLE_VSCODE.test(ref)) {
    Object.assign(plan, all, {publish_vscode:true});
  } else if (tag && INTELLIJ_RELEASE.test(ref)) {
    // An IntelliJ release reruns the shared engine suite and publishes only the verified IntelliJ ZIP.
    Object.assign(plan, {vscode:false,intellij:true,rust:true,publish_intellij:true});
  } else if (tag && ref.startsWith('refs/tags/intellij-v')) {
    Object.assign(plan, {vscode:false,intellij:true,rust:true}); // Prerelease IntelliJ tags validate only.
  } else if (tag && ref.startsWith('refs/tags/cli-v')) {
    // CLI publication lives in cli-package.yml with its own gates; here the shared engine is revalidated.
    Object.assign(plan, {vscode:false,intellij:false,rust:true});
  } else if (tag) {
    Object.assign(plan, all); // Unrecognized tags cannot publish.
  }
  return plan;
}
module.exports = {planChanges};
