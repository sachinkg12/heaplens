// A selected job that was skipped is a failure, not a green release gate.
function checkResults(needs) {
  const required = ['changes','boundary-tests','lint'];
  for (const key of required) {
    if (needs[key]?.result !== 'success') throw new Error(key + ' did not pass');
  }
  for (const [flag,job] of [['rust','test-rust'],['intellij','test-intellij']]) {
    const selected = needs.changes.outputs?.[flag];
    if (!['true','false'].includes(selected)) throw new Error('Missing routing output: ' + flag);
    const result = needs[job]?.result;
    if (selected === 'true' ? result !== 'success' : !['success','skipped'].includes(result)) {
      throw new Error(job + ' did not satisfy the selected check');
    }
  }
}
if (require.main === module) {
  checkResults(JSON.parse(process.env.CI_NEEDS));
  console.log('All selected host and shared checks passed.');
}
module.exports = {checkResults};
