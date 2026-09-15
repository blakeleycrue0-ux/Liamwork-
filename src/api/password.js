import crypto from 'node:crypto';

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

const scrypt = (password, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r, p }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

/** Format: scrypt$N$r$p$saltHex$hashHex */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return ['scrypt', N, r, p, salt.toString('hex'), key.toString('hex')].join('$');
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      expected.length,
      { N: Number(nRaw), r: Number(rRaw), p: Number(pRaw) },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
