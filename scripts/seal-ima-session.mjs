// Plain session data travels only through stdin and memory; stdout is ciphertext.
import {
  constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes,
} from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail() { throw new Error('ima_session_seal_failed'); }

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1024 * 1024) fail();
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!record(input) || !record(input.key) || !record(input.account_info)
      || !record(input.device_info) || typeof input.installation_id !== 'string'
      || !/^[a-f0-9]{32}$/.test(input.installation_id)) fail();
  const key = input.key;
  if (key.algorithm !== 'RSA-OAEP-SHA256+A256GCM'
      || typeof key.public_key_spki !== 'string' || typeof key.key_id !== 'string'
      || !/^[a-f0-9]{64}$/.test(key.key_id)) fail();
  const der = Buffer.from(key.public_key_spki, 'base64');
  if (der.toString('base64') !== key.public_key_spki
      || createHash('sha256').update(der).digest('hex') !== key.key_id) fail();
  const rsa = createPublicKey({key: der, type: 'spki', format: 'der'});
  if (rsa.asymmetricKeyType !== 'rsa' || rsa.asymmetricKeyDetails.modulusLength < 2048) fail();
  const installation_id = input.installation_id;
  const issued_at = new Date().toISOString();
  const key_id = key.key_id;
  const aes = randomBytes(32);
  const iv = randomBytes(12);
  const plain = Buffer.from(JSON.stringify({
    account_info: input.account_info, device_info: input.device_info,
  }));
  try {
    const cipher = createCipheriv('aes-256-gcm', aes, iv);
    // Property order is part of the relay protocol (also lexicographic order).
    cipher.setAAD(Buffer.from(JSON.stringify({installation_id, issued_at, key_id})));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const wrapped = publicEncrypt({key: rsa, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'}, aes);
    process.stdout.write(JSON.stringify({installation_id, issued_at, key_id,
      wrapped_key: wrapped.toString('base64'), iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64')}) + '\n');
  } finally {
    aes.fill(0);
    plain.fill(0);
  }
}

try {
  await main();
} catch {
  // Never include input, exception text, stack traces, or key material.
  process.stderr.write('ima_session_seal_failed\n');
  process.exitCode = 1;
}
