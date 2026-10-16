'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Use the installed desktop editor; never download an editor or touch its usual profile.
// HEAPLENS_EDITOR_CLI selects another compatible desktop host.
// HEAPLENS_STARTUP_DUMP optionally replaces controlled completion with a real dump.
const root = path.resolve(__dirname, '../..');
const cli = process.env.HEAPLENS_EDITOR_CLI || (process.platform === 'darwin'
  ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : undefined);
if (!cli || !fs.existsSync(cli)) {
  throw new Error('Set HEAPLENS_EDITOR_CLI to the installed editor CLI executable.');
}
if (process.env.HEAPLENS_STARTUP_DUMP && !fs.existsSync(process.env.HEAPLENS_STARTUP_DUMP)) {
  throw new Error('HEAPLENS_STARTUP_DUMP does not exist.');
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-startup-host-'));
const report = process.env.HEAPLENS_STARTUP_REPORT || path.join(scratch, 'report.json');
const result = spawnSync(cli, [
  '--user-data-dir=' + path.join(scratch, 'profile'),
  '--extensions-dir=' + path.join(scratch, 'extensions'),
  '--extensionDevelopmentPath=' + root,
  '--extensionTestsPath=' + path.join(root, 'out/test/editorStartup.host.test.js'),
  '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', '--wait'
], {
  env: { ...process.env, HEAPLENS_STARTUP_REPORT: report,
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
  stdio: 'inherit', timeout: process.env.HEAPLENS_STARTUP_DUMP ? 12 * 60_000 : 90_000
});
if (result.error || result.status !== 0 || !fs.existsSync(report)) {
  throw new Error('Startup host did not finish successfully. Profile/logs: ' + scratch + '; ' + (result.error || result.status));
}
const evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
if (evidence.status !== 'passed') { throw new Error('Startup assertions failed; see ' + report); }
console.log(JSON.stringify({ host: evidence.host, status: evidence.status, report, scratch,
  paints: evidence.paints.map(p => ({ ms: p.ms, stage: p.stage, visible: p.visible })) }, null, 2));
