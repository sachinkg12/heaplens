'use strict';
// Read public registry state and verify exact package bytes. Version existence alone is not identity.
const common = require('./release-common.cjs');
class PackageConflict extends Error {}
function verificationOptions(env = process.env) {
  const value = env.HEAPLENS_RELEASE_VERIFY_SECONDS || '900';
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 3600) throw new Error('HEAPLENS_RELEASE_VERIFY_SECONDS must be an integer from 1 to 3600');
  const milliseconds = Number(value)*1000, delayMs = Math.min(20000,milliseconds);
  return {attempts:Math.ceil(milliseconds/delayMs)+1,delayMs};
}
async function json(response, label) {
  if (!response.ok) throw new Error(label + ' lookup failed: HTTP ' + response.status);
  return response.json();
}
async function digest(url, fetchImpl) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Registry returned an unsafe package URL');
  const response = await fetchImpl(url, {redirect:'follow'});
  if (!response.ok) throw new Error('Cannot verify published package: HTTP ' + response.status);
  return common.sha256(Buffer.from(await response.arrayBuffer()));
}
function registries(fetchImpl) {
  return [
    {
      name:'Marketplace', tool:'@vscode/vsce', token:'VSCE_PAT',
      async lookup(candidate) {
        const response = await fetchImpl('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
          method:'POST', headers:{'content-type':'application/json', accept:'application/json;api-version=7.2-preview.1'},
          body:JSON.stringify({filters:[{criteria:[{filterType:7,value:candidate.publisher + '.' + candidate.extension}],pageNumber:1,pageSize:1}], flags:131})
        });
        const result = await json(response, 'Marketplace');
        if (!Array.isArray(result.results) || result.results.length !== 1 || !Array.isArray(result.results[0].extensions)) throw new Error('Malformed Marketplace response');
        const extensions = result.results[0].extensions;
        if (!extensions.length) return null;
        if (extensions.length !== 1) throw new Error('Ambiguous Marketplace extension');
        const extension = extensions[0];
        if (extension.extensionName !== candidate.extension || extension.publisher?.publisherName !== candidate.publisher || !Array.isArray(extension.versions))
          throw new Error('Marketplace identity mismatch');
        const matches = extension.versions.filter(item => item.version === candidate.version && item.targetPlatform === candidate.target);
        if (!matches.length) return null;
        if (matches.length !== 1) throw new Error('Ambiguous Marketplace version/target');
        const item = matches[0];
        const url = item.files?.find(file => file.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')?.source ||
          (item.assetUri && item.assetUri.replace(/\/$/, '') + '/Microsoft.VisualStudio.Services.VSIXPackage');
        if (!url) throw new Error('Existing Marketplace upload cannot be verified');
        return digest(url, fetchImpl);
      }
    },
    {
      name:'Open VSX', tool:'ovsx', token:'OVSX_PAT',
      async lookup(candidate) {
        const url = `https://open-vsx.org/api/${candidate.publisher}/${candidate.extension}/${candidate.target}/${candidate.version}`;
        const response = await fetchImpl(url);
        if (response.status === 404) return null;
        const item = await json(response, 'Open VSX');
        if (item.error || item.namespace !== candidate.publisher || item.name !== candidate.extension || item.version !== candidate.version || item.targetPlatform !== candidate.target)
          throw new Error('Open VSX identity mismatch');
        if (!item.files?.download) throw new Error('Existing Open VSX upload cannot be verified');
        return digest(item.files.download, fetchImpl);
      }
    }
  ];
}
function same(candidate, digest, registry) {
  if (digest !== candidate.sha256) throw new PackageConflict(`${registry} has conflicting bytes for ${candidate.version}/${candidate.target}; nothing is overwritten`);
}
async function publishRegistry({registry, candidates, upload, log = console.log, verify = verificationOptions()}) {
  // Check every target before uploading anything to this registry.
  const state = [];
  for (const candidate of candidates) {
    const digest = await registry.lookup(candidate);
    if (digest !== null) same(candidate, digest, registry.name);
    state.push({candidate, existing:digest !== null});
  }
  for (const {candidate, existing} of state) {
    if (existing) { log(`${registry.name}: ${candidate.target} already matches; skipped`); continue; }
    let uploadError;
    try { await upload(registry, candidate); } catch (error) { uploadError = error; }
    // An upload timeout is ambiguous: verify remote state, never blindly upload twice.
    try {
      await common.retry(async () => {
        const digest = await registry.lookup(candidate);
        if (digest === null) throw new Error('Upload is not yet visible');
        same(candidate, digest, registry.name);
      }, {...verify, log, retryIf:error => !(error instanceof PackageConflict)});
    } catch (error) {
      throw new Error(`${registry.name}: ${candidate.target} upload could not be verified${uploadError ? ' after an upload failure' : ''}. Retry this publish job with the original artifacts. ${error.message}`);
    }
    log(`${registry.name}: ${candidate.target} verified`);
  }
}
module.exports = {registries, publishRegistry, digest, verificationOptions};
