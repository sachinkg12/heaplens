'use strict';
// One release-platform catalog shared by packaging, native CI and publication.
const catalog=require('../platforms.json');
const targets=Object.freeze(Object.keys(catalog));
function platform(target) {
  if(!Object.prototype.hasOwnProperty.call(catalog,target))throw Error('Unsupported IntelliJ package target: '+target);
  return catalog[target];
}
function variantVersion(version,target) {
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('Expected an exact base plugin version');
  return version+platform(target).versionSuffix;
}
function checkHost(target,os=process.platform,arch=process.arch) {
  const value=platform(target);
  if(os!==value.hostOs||arch!==value.hostArch)throw Error(`The ${target} tests require its native ${value.hostOs}/${value.hostArch} runner, received ${os}/${arch}`);
}
module.exports={platform,targets,variantVersion,checkHost};
