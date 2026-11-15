const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {platform,targets,variantVersion,checkHost}=require('./platforms.cjs');
const {metadataArguments}=require('./stage-notices.cjs');
test('dependency notices select the requested native Rust graph rather than Apple Silicon',()=>{
  for(const target of targets){const args=metadataArguments(target);assert.equal(args[args.indexOf('--filter-platform')+1],platform(target).rust);assert.ok(args.includes('--offline'));assert.ok(args.includes('--locked'));}
  assert.throws(()=>metadataArguments('linux-arm64'),/Unsupported/);
  const build=fs.readFileSync(path.join(__dirname,'../build.gradle.kts'),'utf8');
  assert.match(build,/project\.version\.toString\(\), serverTarget\.get\(\)/);
});
test('each release target has an exact platform constraint and unambiguous version',()=>{
  assert.deepEqual(targets,['darwin-arm64','darwin-x64','linux-x64','win32-x64']);
  assert.equal(variantVersion('0.1.20','darwin-arm64'),'0.1.20');
  assert.equal(variantVersion('0.1.20','darwin-x64'),'0.1.20-mac-x86_64');
  assert.equal(variantVersion('0.1.20','linux-x64'),'0.1.20-linux-x86_64');
  assert.equal(variantVersion('0.1.20','win32-x64'),'0.1.20-windows-x86_64');
  assert.equal(platform('linux-x64').os,'linux');
  assert.equal(platform('win32-x64').arch,'x86_64');
  assert.equal(platform('win32-x64').binary,'hprof-server.exe');
  assert.throws(()=>platform('linux-arm64'),/Unsupported/);
  assert.throws(()=>variantVersion('0.1.20; command','linux-x64'),/version/);
});
test('native tests refuse emulated or mismatched host configurations',()=>{
  checkHost('linux-x64','linux','x64');checkHost('win32-x64','win32','x64');checkHost('darwin-arm64','darwin','arm64');
  assert.throws(()=>checkHost('linux-x64','darwin','arm64'),/native/);
  assert.throws(()=>checkHost('win32-x64','win32','arm64'),/native/);
});
test('Gradle and runtime share the target catalog instead of a Mac-only packaging gate',()=>{
  const build=fs.readFileSync(path.join(__dirname,'../build.gradle.kts'),'utf8');
  assert.match(build,/platforms\.json/);
  assert.match(build,/inputs\.file\("platforms\.json"\)/);
  assert.doesNotMatch(build,/require\(serverTarget\.get\(\) == "darwin-arm64"\)/);
  const descriptor=fs.readFileSync(path.join(__dirname,'../src/main/resources/META-INF/plugin.xml'),'utf8');
  assert.match(descriptor,/@heaplens\.os@/);assert.match(descriptor,/@heaplens\.arch@/);
});
