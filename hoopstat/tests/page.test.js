/* The page's own scripts share one global scope: a top-level name declared in two of them stops the page
   ("Identifier ... has already been declared"). Run: node --test hoopstat/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..');

test('no top-level name is declared in two of the page scripts', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((f) => !f.startsWith('vendor/'));
  assert.ok(files.includes('app.js'));
  const seen = new Map();
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^(?:const|let|var|function|class) +([A-Za-z_$][\w$]*)/gm)) {
      assert.ok(!seen.has(m[1]), `${m[1]} is declared in both ${seen.get(m[1])} and ${f}`);
      seen.set(m[1], f);
    }
  }
});
