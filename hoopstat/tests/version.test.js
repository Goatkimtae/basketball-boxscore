/* The app's version (shown in exports) and the offline cache version are bumped together. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('APP_VERSION in app.js equals VERSION in sw.js', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').match(/const APP_VERSION = '([^']+)'/);
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/);
  assert.ok(app && sw, 'both versions are found');
  assert.strictEqual(app[1], sw[1]);
});
