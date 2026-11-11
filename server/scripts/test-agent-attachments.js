'use strict';

// Isolated PostgreSQL only; no production config or database is read.
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const { ensureAgentSchema } = require('../utils/agent-schema');
const { extractDocumentText, decodeText, sniffImageMime } = require('../utils/document-extract');
const {
  readAgentUploads,
  processUploads,
  bindAttachments,
  listThreadAttachments,
  deleteAttachment,
  loadVisionImages,
  attachmentManifest,
  toMessageAttachments
} = require('../utils/agent-attachments');
const { TEST_IMAGE_PNG } = require('../utils/agent-images');
const { htmlToText } = require('../utils/html-text');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  PASS', name);
}

function makePdf(text) {
  const stream = `BT /F1 18 Tf 20 150 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 250] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output));
    output += object;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    output += String(offsets[index]).padStart(10, '0') + ' 00000 n \n';
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function fixture(cluster) {
  const pool = new Pool({ ...cluster.connection, max: 4 });
  await pool.query(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, is_admin BOOLEAN);
    INSERT INTO users VALUES (1, TRUE);
    CREATE TABLE models(id TEXT PRIMARY KEY, output_kind TEXT);
    CREATE TABLE agent_threads(
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), mode TEXT,
      title TEXT, model_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO agent_threads(user_id, mode, title, model_id) VALUES (1,'manage','t','m');
    CREATE TABLE agent_messages(
      id SERIAL PRIMARY KEY, thread_id INTEGER REFERENCES agent_threads(id), role TEXT,
      content TEXT, tool_calls JSONB, tool_call_id TEXT, tool_name TEXT
    );
    CREATE TABLE agent_approvals(
      id SERIAL PRIMARY KEY, thread_id INTEGER REFERENCES agent_threads(id), user_id INTEGER,
      tool_call_id TEXT, tool_name TEXT, arguments JSONB, status TEXT, resolved_at TIMESTAMP
    );
  `);
  await ensureAgentSchema(pool);
  await ensureAgentSchema(pool);
  return pool;
}

async function main() {
  const cluster = createIsolatedPostgres('agent-attachments');
  const pool = await fixture(cluster);
  try {
    await cluster.assertIsolation(pool);

    assert.equal(sniffImageMime(TEST_IMAGE_PNG), 'image/png');
    assert.equal(decodeText(Buffer.from('价格 1.25 元', 'utf8')), '价格 1.25 元');
    assert.equal(decodeText(Buffer.from([0, 1, 2])), null);
    ok('magic and text decoding work');

    const text = await extractDocumentText({
      bytes: Buffer.from('model,price\nGPT-4.1,2.00\n', 'utf8'),
      filename: 'prices.csv',
      mime: 'text/csv'
    });
    assert.equal(text.ok, true);
    assert.equal(text.kind, 'document');
    assert.match(text.text, /GPT-4\.1/);
    ok('CSV text extraction works');

    const pdf = await extractDocumentText({
      bytes: makePdf('Hello Price 1.25 USD'),
      filename: 'prices.pdf',
      mime: 'application/pdf'
    });
    assert.equal(pdf.ok, true);
    assert.match(pdf.text, /Hello Price 1\.25 USD/);
    ok('PDF text extraction works');

    const legacy = await extractDocumentText({
      bytes: Buffer.from('legacy'),
      filename: 'old.doc',
      mime: 'application/msword'
    });
    assert.equal(legacy.ok, false);
    assert.equal(legacy.code, 'legacy_office_unsupported');
    ok('legacy Office formats are rejected');

    const image = await extractDocumentText({
      bytes: TEST_IMAGE_PNG,
      filename: 'shot.png',
      mime: 'image/png'
    });
    assert.equal(image.ok, true);
    assert.equal(image.kind, 'image');
    ok('images keep their bytes');

    const parsedHtml = htmlToText('<html><head><title>Price</title><script>bad()</script></head><body><h1>Models</h1><table><tr><td>GPT</td><td>2.00</td></tr></table></body></html>');
    assert.equal(parsedHtml.title, 'Price');
    assert.match(parsedHtml.text, /Models/);
    assert.match(parsedHtml.text, /GPT/);
    assert.doesNotMatch(parsedHtml.text, /bad\(\)/);
    ok('HTML is reduced to text without scripts');

    const server = http.createServer(async (request, response) => {
      try {
        const upload = await readAgentUploads(request);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          files: upload.files.map(file => ({ name: file.filename, size: file.data.length, mime: file.mimetype })),
          threadId: upload.threadId
        }));
      } catch (error) {
        response.statusCode = error.status || 500;
        response.end(JSON.stringify({ code: error.code, error: error.message }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const form = new FormData();
      form.append('thread_id', '1');
      form.append('files', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'hello.txt');
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', body: form });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.files[0].name, 'hello.txt');
      assert.equal(data.files[0].size, 5);
      assert.equal(data.threadId, '1');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    ok('multipart uploads parse with filenames and thread ids');

    const uploads = await processUploads(pool, {
      userId: 1,
      threadId: 1,
      files: [
        { data: Buffer.from('model,price\nGPT-4.1,2.00\n', 'utf8'), filename: 'prices.csv', mimetype: 'text/csv' },
        { data: TEST_IMAGE_PNG, filename: 'shot.png', mimetype: 'image/png' }
      ]
    });
    assert.equal(uploads.errors.length, 0);
    assert.equal(uploads.attachments.length, 2);
    assert.equal(uploads.attachments[0].kind, 'document');
    assert.equal(uploads.attachments[1].kind, 'image');
    assert.match(attachmentManifest(uploads.attachments), /prices\.csv/);
    assert.equal(toMessageAttachments(uploads.attachments).length, 2);
    ok('uploads are parsed and stored');

    const bound = await bindAttachments(pool, {
      userId: 1,
      threadId: 1,
      ids: uploads.attachments.map(item => item.id)
    });
    assert.equal(bound.length, 2);
    const listed = await listThreadAttachments(pool, { userId: 1, threadId: 1 });
    assert.equal(listed.length, 2);
    const images = await loadVisionImages(pool, {
      userId: 1,
      threadId: 1,
      ids: bound.map(item => item.id)
    });
    assert.equal(images.length, 1);
    assert.equal(images[0].mime, 'image/png');
    assert.ok(images[0].base64.length > 0);
    ok('attachments bind to a thread and images can be materialized');

    const duplicate = await processUploads(pool, {
      userId: 1,
      threadId: 1,
      files: [{ data: Buffer.from('model,price\nGPT-4.1,2.00\n', 'utf8'), filename: 'prices.csv', mimetype: 'text/csv' }]
    });
    assert.equal(duplicate.attachments[0].id, uploads.attachments[0].id, 'same content reuses the attachment');
    ok('duplicate uploads are reused');

    const deleted = await deleteAttachment(pool, { id: uploads.attachments[1].id, userId: 1, threadId: 1 });
    assert.equal(deleted, true);
    const afterDelete = await listThreadAttachments(pool, { userId: 1, threadId: 1 });
    assert.equal(afterDelete.length, 1);
    ok('attachments can be deleted by their owner');

    const otherUser = await bindAttachments(pool, { userId: 2, threadId: 1, ids: [uploads.attachments[0].id] })
      .then(() => false, () => true);
    assert.equal(otherUser, true);
    ok('other users cannot bind attachments');

    console.log(`\n${passed} assertions passed`);
  } finally {
    await pool.end();
    cluster.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
