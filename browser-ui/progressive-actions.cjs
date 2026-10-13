'use strict';
// Additive session capability. Reading a tab never escalates engine work.
module.exports.install = session => {
    session.commands.set('quickScan', () => session.analyze('shallow'));
    session.commands.set('analyzeRetained', () => session.analyze('full'));
};
