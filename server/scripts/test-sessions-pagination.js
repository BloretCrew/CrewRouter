'use strict';

const assert = require('assert');
const { hasMoreDetailRows } = require('../routes/sessions-view');

function pageSizes(total, pageSize) {
  const sizes = [];
  for (let page = 1; ; page += 1) {
    const loadedBefore = (page - 1) * pageSize;
    const rowCount = Math.min(pageSize, Math.max(0, total - loadedBefore));
    sizes.push(rowCount);
    if (!hasMoreDetailRows(rowCount, total, page, pageSize)) return sizes;
  }
}

assert.deepStrictEqual(pageSizes(45, 40), [40, 5]);
assert.deepStrictEqual(pageSizes(100, 40), [40, 40, 20]);
assert.strictEqual(hasMoreDetailRows(0, 45, 2, 40), false);
assert.strictEqual(hasMoreDetailRows(40, 80, 2, 40), false);

console.log('sessions detail pagination tests passed');
