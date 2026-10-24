export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

export function secretsMatch(expected: string, supplied: string): boolean {
  if (expected.length !== supplied.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}
