import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LLAMA_SOURCE_PATCH_SHA256 } from '../../src/services/LlamaSourcePatchIdentity';

it('invalidates execution/index identities when the guarded native patch changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../patches/llama-rn-0.13.0-rc.3.js'), 'utf8').replace(/\r\n/g, '\n');
  expect(createHash('sha256').update(source).digest('hex')).toBe(LLAMA_SOURCE_PATCH_SHA256);
});
