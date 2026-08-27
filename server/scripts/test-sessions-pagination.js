'use strict';

const assert = require('assert');
const {
  hasMoreCursorPage,
  hasMoreCompressedSlice,
  buildDetailNextCursor,
} = require('../routes/sessions-view');

function paginateNonCompressed(total, pageSize) {
  const records = Array.from({ length: total }, (_, index) => ({ id: index + 1 }));
  const pages = [];
  let cursorIndex = total;

  while (cursorIndex > 0) {
    // Simulate DESC query, LIMIT pageSize + 1, then outer ASC reorder.
    const eligible = records.slice(0, cursorIndex).reverse();
    const fetched = eligible.slice(0, pageSize + 1).reverse();
    const hasMore = hasMoreCursorPage(fetched.length, pageSize);
    const pageRows = fetched.slice(-pageSize);
    pages.push({ ids: pageRows.map(row => row.id), hasMore });
    cursorIndex = pageRows[0]?.id ? pageRows[0].id - 1 : 0;
    if (!hasMore) break;
  }
  return pages;
}

function paginateCompressed(total, pageSize) {
  const pages = [];
  let sliceEnd = total;
  while (sliceEnd > 0) {
    const sliceStart = Math.max(0, sliceEnd - pageSize);
    const pageRows = Array.from({ length: sliceEnd - sliceStart }, (_, index) => sliceStart + index + 1);
    pages.push({ ids: pageRows, hasMore: hasMoreCompressedSlice(sliceStart) });
    sliceEnd = sliceStart;
  }
  return pages;
}

function paginateCompressedWithCursor(total, pageSize) {
  const rows = Array.from({ length: total }, (_, index) => ({
    created_at: `2026-08-27T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
    id: index + 1,
  }));
  const pages = [];
  let sliceEnd = total;
  while (sliceEnd > 0) {
    const sliceStart = Math.max(0, sliceEnd - pageSize);
    const pageRows = rows.slice(sliceStart, sliceEnd);
    const hasMore = hasMoreCompressedSlice(sliceStart);
    pages.push({
      ids: pageRows.map(row => row.id),
      nextCursor: buildDetailNextCursor(hasMore, pageRows[0]),
    });
    sliceEnd = sliceStart;
  }
  return pages;
}

function assertUniquePageCoverage(pages, total) {
  const ids = pages.flatMap(page => page.ids);
  assert.strictEqual(ids.length, total);
  assert.strictEqual(new Set(ids).size, total);
}

assert.deepStrictEqual(paginateNonCompressed(45, 40), [
  { ids: Array.from({ length: 40 }, (_, index) => index + 6), hasMore: true },
  { ids: Array.from({ length: 5 }, (_, index) => index + 1), hasMore: false },
]);
assert.deepStrictEqual(paginateNonCompressed(100, 40), [
  { ids: Array.from({ length: 40 }, (_, index) => index + 61), hasMore: true },
  { ids: Array.from({ length: 40 }, (_, index) => index + 21), hasMore: true },
  { ids: Array.from({ length: 20 }, (_, index) => index + 1), hasMore: false },
]);
assert.deepStrictEqual(paginateCompressed(45, 40), [
  { ids: Array.from({ length: 40 }, (_, index) => index + 6), hasMore: true },
  { ids: Array.from({ length: 5 }, (_, index) => index + 1), hasMore: false },
]);
assert.deepStrictEqual(paginateCompressed(100, 40), [
  { ids: Array.from({ length: 40 }, (_, index) => index + 61), hasMore: true },
  { ids: Array.from({ length: 40 }, (_, index) => index + 21), hasMore: true },
  { ids: Array.from({ length: 20 }, (_, index) => index + 1), hasMore: false },
]);

const compressed45 = paginateCompressedWithCursor(45, 40);
assert.deepStrictEqual(compressed45.map(page => page.nextCursor), [
  { beforeCreatedAt: '2026-08-27T00:00:06.000Z', beforeId: 6 },
  null,
]);
assertUniquePageCoverage(compressed45, 45);

const compressed100 = paginateCompressedWithCursor(100, 40);
assert.deepStrictEqual(compressed100.map(page => page.nextCursor), [
  { beforeCreatedAt: '2026-08-27T00:00:61.000Z', beforeId: 61 },
  { beforeCreatedAt: '2026-08-27T00:00:21.000Z', beforeId: 21 },
  null,
]);
assertUniquePageCoverage(compressed100, 100);

assert.strictEqual(hasMoreCursorPage(0, 40), false);
assert.strictEqual(hasMoreCursorPage(40, 40), false);
assert.strictEqual(hasMoreCursorPage(41, 40), true);

function firstNonCompressedPageCursor(total, pageSize) {
  const records = Array.from({ length: total }, (_, index) => ({
    created_at: `2026-08-27T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
    id: index + 1,
  }));
  const fetched = records.slice(0, total).reverse().slice(0, pageSize + 1).reverse();
  const pageRows = fetched.slice(-pageSize);
  return buildDetailNextCursor(fetched.length > pageSize, pageRows[0]);
}

assert.deepStrictEqual(firstNonCompressedPageCursor(45, 40), {
  beforeCreatedAt: '2026-08-27T00:00:06.000Z',
  beforeId: 6,
});
assert.deepStrictEqual(firstNonCompressedPageCursor(100, 40), {
  beforeCreatedAt: '2026-08-27T00:00:61.000Z',
  beforeId: 61,
});
assert.deepStrictEqual(
  buildDetailNextCursor(true, { created_at: '2026-08-27T00:00:00.000Z', id: 123 }),
  { beforeCreatedAt: '2026-08-27T00:00:00.000Z', beforeId: 123 }
);
assert.strictEqual(buildDetailNextCursor(false, { created_at: '2026-08-27T00:00:00.000Z', id: 123 }), null);

console.log('sessions detail pagination tests passed');
