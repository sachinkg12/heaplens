'use strict';
// Exact direct tool versions, shared by packaging and publication. VSCE 3.6.2
// retains compatibility with the existing Node 20 packaging runners.
const common = require('./release-common.cjs');
const {TARGETS} = require('./vscode-candidate.cjs');
const PINS = Object.freeze({'@vscode/vsce':'@vscode/vsce@3.6.2',ovsx:'ovsx@1.3.0'});
// On Windows npx is npx.cmd, which only runs through a shell, so every argument is
// restricted to a fixed charset, so there is no quoting or injection to reason about.
const SAFE_ARGUMENT = /^[A-Za-z0-9@./_:\\-]+$/;
function runTool(tool, args, options = {}, run = common.run, platform = process.platform) {
  if (!Object.hasOwn(PINS,tool)) throw new Error('Unknown release tool: ' + tool);
  for (const argument of args) if (!SAFE_ARGUMENT.test(argument)) throw new Error('Unsafe release tool argument: ' + argument);
  return run('npx',['--yes',PINS[tool],...args],{...(platform === 'win32' ? {shell:true} : {}),...options});
}
function publicationEnvironment(environment, token) {
  const result = {...environment};
  for (const name of ['VSCE_PAT','OVSX_PAT','GH_TOKEN','GITHUB_TOKEN','NPM_TOKEN','NODE_AUTH_TOKEN']) delete result[name];
  result[token] = environment[token];
  return result;
}
if (require.main === module) {
  try {
    const [command,target,...extra] = process.argv.slice(2);
    if (command !== 'package' || !TARGETS.includes(target) || extra.length) throw new Error('Usage: vscode-tools.cjs package TARGET');
    runTool('@vscode/vsce',['package','--target',target],{stdio:'inherit'});
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {PINS,runTool,publicationEnvironment};
