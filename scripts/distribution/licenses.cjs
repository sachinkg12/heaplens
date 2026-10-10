'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readRegular, write, inventory } = require('./files.cjs');
function dependencyNotices(metadata, destination) {
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node])), ids = new Set();
  function visit(id) {
    if (ids.has(id)) return; ids.add(id);
    for (const dep of nodes.get(id)?.deps || [])
      if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
  }
  visit(metadata.resolve.root);
  const records = [];
  for (const pkg of metadata.packages.filter(pkg => ids.has(pkg.id) && pkg.id !== metadata.resolve.root)) {
    const dir = path.dirname(pkg.manifest_path);
    const names = new Set(fs.readdirSync(dir).filter(name => /^(LICENSE|COPYING|COPYRIGHT|NOTICE)/i.test(name)));
    if (pkg.license_file) names.add(pkg.license_file);
    const notices = [];
    for (const name of [...names].sort()) {
      const file = path.resolve(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        // Some crates keep their license texts in a dedicated LICENSES folder.
        for (const entry of inventory(file)) {
          const relative = 'licenses/rust/' + pkg.name + '-' + pkg.version + '/' + name + '/' + entry.path;
          write(destination, relative, readRegular(path.join(file, entry.path))); notices.push(relative);
        }
      } else {
        const relative = 'licenses/rust/' + pkg.name + '-' + pkg.version + '/' + path.basename(name);
        write(destination, relative, readRegular(file)); notices.push(relative);
      }
    }
    if (!notices.length) throw Error('Missing bundled dependency license texts for ' + pkg.name);
    records.push({ name: pkg.name, version: pkg.version, license: pkg.license, authors: pkg.authors,
      repository: pkg.repository, notices });
  }
  return records;
}
module.exports = { dependencyNotices };
