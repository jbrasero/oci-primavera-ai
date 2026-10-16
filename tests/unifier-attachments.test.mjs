import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { zipAttachments } from '../dist/unifier-attachments.js';

test('creates an in-memory ZIP suitable for Unifier attachment payloads', () => {
  const zip = zipAttachments([{ name: 'contract.pdf', content: Buffer.from('contract body') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  const nameLength = zip.readUInt16LE(26);
  const compressedLength = zip.readUInt32LE(18);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), 'contract.pdf');
  assert.equal(inflateRawSync(zip.subarray(30 + nameLength, 30 + nameLength + compressedLength)).toString(), 'contract body');
});
