'use strict';
// Release notes are a user-facing policy, not the conservative CI check-selection policy.
const {HOSTS} = require('./release-model.cjs');
const common = require('./release-common.cjs');
const internal = file => /^(?:\.github\/|scripts\/|papers\/|docs\/|docs-site\/|traffic\/|media\/screenshots\/|\.review|\.spe-)/.test(file) ||
  /(?:^|\/)(?:tests?|fixtures|examples|benches|target|build|node_modules)\//.test(file) ||
  /(?:\.md|\.test\.[^/]+|Test\.java)$/.test(file) || /(?:^|\/)AGENTS\.md$/.test(file);
function classify(files) {
  const hosts = new Set(); let shared = false;
  for (const file of files) {
    if (file === 'scripts/distribution/launcher.cjs') { hosts.add('cli'); continue; }
    if (internal(file)) continue;
    if (/^hprof-analyzer\/src\/(?:cli\/|heaplens\.rs$)/.test(file)) { hosts.add('cli'); continue; }
    if (/^hprof-analyzer\/(?:src\/|crates\/)/.test(file) || /^telemetry\/(?!.*test)/.test(file)) {
      for (const host of Object.keys(HOSTS)) hosts.add(host);
      shared = true;
    } else if (/^src\/webview\/|^media\/d3\./.test(file)) {
      for (const host of Object.keys(HOSTS)) hosts.add(host);
    } else if (/^intellij-plugin\/src\/main\//.test(file)) hosts.add('intellij');
    else if (/^browser-ui\//.test(file)) hosts.add('cli');
    else if (/^src\//.test(file)) hosts.add('vscode');
  }
  return {hosts:[...hosts], shared};
}
const escapeMarkdown = text => text.replace(/[\\`*_[\]<>]/g, '\\$&');
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
function history({baseline, head, git}) {
  common.requireAncestry(baseline, head, undefined, args => git(args));
  // The baseline must be on the release branch, not a commit on a merged side branch.
  const chain = git(['rev-list', '--first-parent', head]).trim().split('\n');
  if (!chain.includes(baseline)) throw new Error('Baseline is not on first-parent release history');
  const shas = git(['rev-list', '--first-parent', '--reverse', `${baseline}..${head}`]).trim().split('\n').filter(Boolean);
  return shas.map(sha => {
    common.commitSha(sha);
    const message = git(['show', '-s', '--format=%B', sha]).trim();
    const [subject, ...body] = message.split('\n');
    const merge = /^Merge pull request #(\d+)\b/.exec(subject);
    const title = merge ? body.find(line => line.trim()) || subject : subject;
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', `${sha}^1`, sha]).split('\0').filter(Boolean);
    return {sha, title, pr:merge ? Number(merge[1]) : null, files};
  }).filter(change => !/^(?:chore\(release\)|chore\(traffic\)|Merge pull request.*release\/)/i.test(change.title));
}
function section({host, baseline, changes}) {
  return {
    baseline,
    entries:changes.filter(change => classify(change.files).hosts.includes(host)).map(change => {
      const title = change.title.replace(/[\r\n\u0000-\u001f]/g, ' ').trim();
      const generic = /^(?:fix|update|wip|changes?|chore|feat|refactor)[:!\s]*$/i.test(title) || title.split(/\s+/).length < 3;
      return {title: generic ? 'REVIEW: ' + title : title, sha:change.sha, pr:change.pr, shared:classify(change.files).shared};
    })
  };
}
function markdown(section, repository) {
  const lines = [`Changes since ${section.baseline.version} (source ${section.baseline.commit.slice(0, 12)}).`, ''];
  if (!section.entries.length) lines.push('- Coordinated maintenance release; no new user-facing changes in this range.');
  for (const entry of section.entries) {
    const label = entry.pr ? '#' + entry.pr : entry.sha.slice(0, 12);
    const url = `https://github.com/${repository}/${entry.pr ? 'pull/' + entry.pr : 'commit/' + entry.sha}`;
    lines.push(`- ${escapeMarkdown(entry.title)}${entry.shared ? ' [shared engine]' : ''} ([${label}](${url}))`);
  }
  return lines.join('\n');
}
function html(section, repository) {
  const lines = [`<p>Changes since ${escapeHtml(section.baseline.version)} (source ${section.baseline.commit.slice(0, 12)}).</p>`, '<ul>'];
  if (!section.entries.length) lines.push('<li>Coordinated maintenance release; no new user-facing changes in this range.</li>');
  for (const entry of section.entries) {
    const url = `https://github.com/${repository}/${entry.pr ? 'pull/' + entry.pr : 'commit/' + entry.sha}`;
    lines.push(`<li>${escapeHtml(entry.title)}${entry.shared ? ' [shared engine]' : ''} (<a href="${url}">${entry.pr ? '#' + entry.pr : entry.sha.slice(0, 12)}</a>)</li>`);
  }
  return [...lines, '</ul>'].join('\n');
}
function changelog(plan) {
  return `## [${plan.versions.vscode}] - ${plan.date}\n\n` + Object.keys(HOSTS).map(host =>
    `### ${HOSTS[host].label} ${plan.versions[host]}\n\n${markdown(plan.notes[host], plan.repository)}\n`).join('\n');
}
function requireReviewed(plan) {
  for (const host of Object.keys(HOSTS)) for (const entry of plan.notes[host].entries)
    if (/^(?:REVIEW|TODO):/i.test(entry.title)) throw new Error('Release note requires review: ' + host + ': ' + entry.title);
}
module.exports = {classify, history, section, markdown, html, changelog, requireReviewed};
