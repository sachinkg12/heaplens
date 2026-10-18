'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {PLAN} = require('./release-model.cjs');
const notes = require('./release-notes.cjs');
function hostNotes(root, host, version) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, PLAN), 'utf8'));
  if (plan.schema !== 1 || plan.versions[host] !== version) throw new Error('Missing or mismatched prepared release notes');
  notes.requireReviewed(plan);
  return notes.markdown(plan.notes[host], plan.repository);
}
module.exports = {hostNotes};
