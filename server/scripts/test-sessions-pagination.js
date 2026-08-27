'use strict';

const assert = require('assert');
const {
  hasMoreCursorPage,
  hasMoreCompressedSlice,
  buildDetailNextCursor,
} = require('../routes/sessions-view');

function cursorPages(total, pageSize) {
  const pages = [];
  let remaining = total;
  while (remaining > 0) {
    const fetchedRowCount = Math.min(pageSize + 1, remaining);
    const rowCount = Math.min(pageSize, fetchedRowCount);
    pages.push({ rowCount, hasMore: hasMoreCursorPage(fetchedRowCount, pageSize) });
    remaining -= rowCount;
  }
  return pages;
}

assert.deepStrictEqual(cursorPages(45, 40), [
  { rowCount: 40, hasMore: true },
  { rowCount: 5, hasMore: false },
]);
assert.deepStrictEqual(cursorPages(100, 40), [
  { rowCount: 40, hasMore: true },
  { rowCount: 40, hasMore: true },
  { rowCount: 20, hasMore: false },
]);

assert.strictEqual(hasMoreCursorPage(0, 40), false);
assert.strictEqual(hasMoreCursorPage(40, 40), false);
assert.strictEqual(hasMoreCursorPage(41, 40), true);
assert.strictEqual(hasMoreCompressedSlice(5), true);
assert.strictEqual(hasMoreCompressedSlice(0), false);
assert.deepStrictEqual(
  buildDetailNextCursor(true, { created_at: '2026-08-27T00:00:00.000Z', id: 123 }),
  { beforeCreatedAt: '2026-08-27T00:00:00.000Z', beforeId: 123 }
);
assert.strictEqual(buildDetailNextCursor(false, { created_at: '2026-08-27T00:00:00.000Z', id: 123 }), null);

console.log('sessions detail pagination tests passed');
