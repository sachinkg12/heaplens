'use strict';
// Network writes are opt-in. The default is a read-only preflight against an exact merged commit.
const common = require('./release-common.cjs');
const model = require('./release-model.cjs');
const {validate} = require('./validate-release.cjs');
// Explicitly allow non-release data/documentation only; note routing would incorrectly
// exempt manifests, build/publishing scripts and other release-critical paths here.
function followsRelease(file) {
  return /^(?:traffic\/|docs\/|docs-site\/docs\/|papers\/)/.test(file) || /^(?:README|CHANGELOG)\.md$/.test(file) ||
    /^(?:intellij-plugin|hprof-analyzer|browser-ui)\/(?:README\.md$|docs\/)/.test(file);
}
function successfulRun(runs, jobs, sha, workflow = '.github/workflows/ci.yml') {
  const candidates = runs.filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === 'main' &&
    run.path === workflow).sort((a,b) => b.id - a.id);
  const run = candidates[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('No successful main push run for the exact release commit');
  const matches = jobs(run.id).filter(job => job.name === 'checks');
  if (matches.length !== 1 || matches[0].conclusion !== 'success' || matches[0].status !== 'completed')
    throw new Error('The exact run has no successful aggregate checks job');
  return run.id;
}
function tagRelease({root, sha, execute = false, git, gh}) {
  common.commitSha(sha);
  git ||= args => common.run('git', args, {cwd:root});
  gh ||= args => common.run('gh', args, {cwd:root});
  // Fetch objects without moving the local branch or importing tags. FETCH_HEAD is
  // the observed remote tip; an already-merged release may precede a skip-CI snapshot.
  git(['fetch','--no-tags','origin','refs/heads/main']);
  const remote = git(['rev-parse','--verify','FETCH_HEAD^{commit}']).trim();
  common.commitSha(remote);
  common.requireAncestry(sha,remote,root,args=>git(args));
  const following = git(['diff','--no-renames','--name-only','-z',sha,remote]).split('\0').filter(Boolean);
  const critical = following.filter(file=>!followsRelease(file));
  if (critical.length) throw new Error('Release-critical changes follow the tested release SHA: ' + critical.join(', '));
  const read = file => git(['show', `${sha}:${file}`]);
  const result = validate({read, git, head:sha, release:true});
  const repository = result.plan.repository;
  const origin = git(['remote','get-url','origin']).trim();
  const identity = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
  if (identity !== repository) throw new Error('Release repository does not match origin');
  const runs = JSON.parse(gh(['api', `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`])).workflow_runs;
  const run = successfulRun(runs, id => {
    const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${id}/jobs?filter=latest&per_page=100`]));
    return pages.flatMap(page => page.jobs);
  }, sha);
  const tags = Object.keys(model.HOSTS).map(host => model.HOSTS[host].prefix + result.versions[host]);
  const refs = git(['ls-remote', '--tags', 'origin']).trim().split('\n');
  for (const tag of tags) {
    if (refs.some(line => line.split(/\s+/)[1]?.replace(/\^\{\}$/, '') === 'refs/tags/' + tag)) throw new Error('Remote tag already exists: ' + tag);
  }
  for (const host of Object.keys(model.HOSTS)) for (const line of refs) {
    const reference = line.split(/\s+/)[1];
    let existing;
    try { existing = common.tagVersion(reference, model.HOSTS[host].prefix); } catch { continue; }
    if (common.compareVersions(result.versions[host], existing) <= 0) throw new Error('Release version does not exceed remote tags: ' + host);
  }
  if (execute) {
    // Explicit SHA:refspecs create lightweight remote tags without touching local tags or branches.
    git(['push', '--atomic', 'origin', ...tags.map(tag => `${sha}:refs/tags/${tag}`)]);
  }
  return {sha, main:remote, following, run, tags, pushed:execute};
}
function main(argv = process.argv.slice(2)) {
  const execute = argv.includes('--execute');
  const options = model.parseOptions(argv.filter(arg => arg !== '--execute'), ['--sha']);
  console.log(JSON.stringify(tagRelease({root:process.cwd(), sha:options['--sha'], execute}), null, 2));
  if (!execute) console.log('Fetch-only preflight; no remote writes. Pass --execute explicitly to push the three tags and start publication.');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = {tagRelease, successfulRun, followsRelease, main};
