/**
 * Makes docs/examples/championship-blue.oto again from the design that comes with OTO (assets/designs/championship-blue), so the example
 * to download is always the default look. tests/server/default-design.test.js fails when they differ.
 *
 * Run with: npm run pack:example
 */

const fs = require('node:fs');
const path = require('node:path');
const { bundledPackage } = require('../src/services/default-design');

const out = path.join(__dirname, '..', 'docs', 'examples', 'championship-blue.oto');
fs.writeFileSync(out, bundledPackage(path.join(__dirname, '..', 'assets')));
console.log(out);
