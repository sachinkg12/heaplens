const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {planChanges} = require('./change-policy.cjs');

function changedPaths(eventName, event, sha, cwd = process.cwd()) {
  const git = args => execFileSync('git', args, {cwd,encoding:'utf8',maxBuffer:32 * 1024 * 1024});
  const revision = value => {
    if (!/^[a-f0-9]{40,64}$/i.test(value || '')) throw new Error('Missing or invalid event revision');
    return value;
  };
  let from, to;
  if (eventName === 'pull_request') {
    to = revision(event.pull_request?.head?.sha);
    from = git(['merge-base', revision(event.pull_request?.base?.sha), to]).trim();
  } else if (eventName === 'push') {
    to = revision(sha);
    const before = revision(event.before);
    if (/^0+$/.test(before)) return git(['ls-tree','-r','--name-only','-z',to]).split('\0').filter(Boolean);
    from = before;
  } else {
    throw new Error('Unsupported workflow event');
  }
  // No path-filter API limits; deletions and both sides of renames are classified.
  return git(['diff','--no-renames','--name-only','-z',from,to,'--']).split('\0').filter(Boolean);
}
function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME, ref = process.env.GITHUB_REF;
  // Tags have explicit plans; do not infer scope from an arbitrary previous tag.
  const paths = eventName === 'push' && ref.startsWith('refs/tags/') ? [] :
    changedPaths(eventName, event, process.env.GITHUB_SHA);
  const plan = planChanges(paths, {eventName,ref,message:event.head_commit?.message});
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(plan).map(([key,value]) => key + '=' + value + '\n').join(''));
  console.log('Selected checks and release policy:', JSON.stringify(plan));
}
if (require.main === module) main();
module.exports = {changedPaths};
