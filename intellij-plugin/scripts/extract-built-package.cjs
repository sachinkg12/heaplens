// Extract one trusted, locally built archive for exact-payload smoke tests, not installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
function extract(distributions, target) {
  if (target !== 'darwin-arm64') throw new Error('The first release package is macOS ARM64 only');
  const input=fs.lstatSync(distributions);
  if(!input.isDirectory() && !input.isFile())throw new Error('Expected a regular archive or distribution directory');
  const archives=input.isFile()?[path.basename(distributions)]:fs.readdirSync(distributions).filter(name=>name.endsWith(`-${target}.zip`));
  if(archives.length!==1 || !archives[0].endsWith(`-${target}.zip`))throw new Error('Expected exactly one matching archive; select the current ZIP explicitly in a reused distribution folder');
  const archive=input.isFile()?path.resolve(distributions):path.resolve(distributions,archives[0]);
  if(!fs.lstatSync(archive).isFile())throw new Error('Archive must be a regular file, not a symbolic link');
  const entries=execFileSync('jar',['tf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
  if(entries.some(entry=>entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..') || !entry.startsWith('heaplens-intellij/')))
    throw new Error('Unexpected distribution entry');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-packaged-smoke-'));
  execFileSync('jar',['xf',archive],{cwd:temporary,stdio:['ignore','pipe','pipe']});
  const root=path.join(temporary,'heaplens-intellij');
  if(!fs.statSync(root).isDirectory())throw new Error('Missing extracted plugin');
  return root;
}
if(require.main===module){
  try{process.stdout.write(extract(...process.argv.slice(2))+'\n');}
  catch(error){console.error(`Cannot extract test package: ${error.message}`);process.exitCode=1;}
}
module.exports={extract};
