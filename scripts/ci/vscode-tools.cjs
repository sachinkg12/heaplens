'use strict';
// Exact direct tool versions, shared by packaging and publication. VSCE 3.6.2
// retains compatibility with the existing Node 20 packaging runners.
const common = require('./release-common.cjs');
const {TARGETS} = require('./vscode-candidate.cjs');
const PINS = Object.freeze({'@vscode/vsce':'@vscode/vsce@3.6.2',ovsx:'ovsx@1.3.0'});
function runTool(tool, args, options = {}, run = common.run) {
  if (!Object.hasOwn(PINS,tool)) throw new Error('Unknown release tool: ' + tool);
  return run('npx',['--yes',PINS[tool],...args],options);
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
