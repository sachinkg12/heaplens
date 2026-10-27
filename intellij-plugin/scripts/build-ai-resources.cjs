// Reuse the existing provider catalogue and system prompt without a runtime Node dependency.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../node_modules/typescript');
const root = path.resolve(__dirname, '../..');
function exportsOf(file) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText;
  const context = {exports:{},require:name=>{
    if(name==='crypto')return require('node:crypto');
    if (name==='./diagnosisPolicy') return exportsOf('src/diagnosisPolicy.ts');
    if (name==='./aiToolProtocol') return exportsOf('src/aiToolProtocol.ts');
    if (name==='https' || name==='http') return {};
    if (name==='url') return {URL};
    throw new Error('Unexpected build-time import');
  }};
  vm.runInNewContext(js,context,{filename:file,timeout:5000});
  return context.exports;
}
const providers = exportsOf('src/llmClient.ts').PROVIDER_REGISTRY;
const prompt = exportsOf('src/promptTemplates.ts').HEAP_ANALYSIS_SYSTEM_PROMPT;
const output = path.resolve(__dirname,'../build/generated/ai/ai');
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'providers.json'),JSON.stringify(providers,null,2));
fs.writeFileSync(path.join(output,'system-prompt.txt'),prompt);
fs.writeFileSync(path.join(output,'diagnosis-policy.txt'),exportsOf('src/diagnosisPolicy.ts').DIAGNOSIS_POLICY);
const investigation=exportsOf('src/aiInvestigation.ts');
fs.writeFileSync(path.join(output,'investigation-contract.json'),JSON.stringify({schema_version:1,limits:investigation.INVESTIGATION_LIMITS,operations:investigation.READ_OPERATIONS,protocol:investigation.CHAT_POLICY,tool:exportsOf('src/aiToolProtocol.ts').HEAP_READ_TOOL},null,2));
fs.writeFileSync(path.join(output,'fix-system-prompt.txt'),exportsOf('src/promptTemplates.ts').AI_FIX_SYSTEM_PROMPT);
console.log('Generated AI provider catalogue and prompt from shared sources; no credentials included.');
