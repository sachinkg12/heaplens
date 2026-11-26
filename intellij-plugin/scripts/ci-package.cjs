'use strict';
// Native CI entry point. Launch Java directly so Windows never depends on Bash
// path translation or .bat argument quoting for native process test inputs.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {platform,checkHost,variantVersion}=require('./platforms.cjs');
const {extract}=require('./extract-built-package.cjs');
function run(command,args,cwd) {execFileSync(command,args,{cwd,stdio:'inherit',env:{...process.env,DO_NOT_TRACK:'1'}});}
function main(target) {
  checkHost(target);
  const selected=platform(target),root=path.resolve(__dirname,'../..');
  const gradle=path.join(root,'intellij-plugin');
  const binary=path.join(root,'hprof-analyzer/target/release',selected.binary);
  if(!fs.lstatSync(binary).isFile())throw Error('Missing native server');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens native fixture '));
  let installed;
  const args=['-classpath',path.join(gradle,'gradle/wrapper/gradle-wrapper.jar'),'org.gradle.wrapper.GradleWrapperMain','-p',gradle,'--no-daemon'];
  const properties=[`-PheaplensServerTarget=${target}`,`-PheaplensServerBinary=${binary}`];
  try {
    run('javac',['-d',fixture,path.join(root,'hprof-analyzer/tests/fixtures/ClassRetainedCounterexample.java')],root);
    const dump=path.join(fixture,'ci smoke.hprof');
    run('java',['-Xmx128m','-cp',fixture,'ClassRetainedCounterexample',dump],root);
    run('java',[...args,'buildPlugin','verifyPluginProjectConfiguration',...properties],root);
    installed=extract(path.join(gradle,'build/distributions'),target);
    const packaged=path.join(installed,'native',target,selected.binary);
    run('java',[...args,'test','verifyPlugin',...properties,'-Dheaplens.test.ci=true',
      `-Dheaplens.test.server=${packaged}`,`-Dheaplens.test.dump=${dump}`,`-Dheaplens.test.pluginRoot=${installed}`],root);
    const output=path.join(gradle,'build/distributions');
    const archives=fs.readdirSync(output).filter(name=>name.endsWith(`-${target}.zip`));
    if(archives.length!==1)throw Error('Expected exactly one current platform ZIP');
    const archive=archives[0],digest=crypto.createHash('sha256').update(fs.readFileSync(path.join(output,archive))).digest('hex');
    const base=/^version = "([^"\n]+)"$/m.exec(fs.readFileSync(path.join(gradle,'build.gradle.kts'),'utf8'))?.[1];
    fs.writeFileSync(path.join(output,'SHA256SUMS'),`${digest}  ${archive}\n`);
    fs.writeFileSync(path.join(output,'candidate.json'),JSON.stringify({target,base_version:base,descriptor_version:variantVersion(base,target),
      archive,sha256:digest,source_commit:process.env.GITHUB_SHA||null,os:process.platform,arch:process.arch,runner_image:process.env.ImageVersion||null,
      native_tests:true,interactive_ui_acceptance:false},null,2)+'\n');
    console.log(`Verified native package ${archive}: ${digest}`);
  } finally {
    fs.rmSync(fixture,{recursive:true,force:true}); // Only this invocation's generated fixture.
    if(installed)fs.rmSync(path.dirname(installed),{recursive:true,force:true}); // extract() owns this temporary root.
  }
}
if(require.main===module){try{main(process.argv[2]);}catch(error){console.error(error);process.exitCode=1;}}
module.exports={main};
