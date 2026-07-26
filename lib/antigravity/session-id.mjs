// sessionId: 64-bit FNV matching AG proxy/common/session.rs derive_session_id.
// offset basis 0xCBF29CE484222325 (i64 -3750763034362895579),
// prime 0x100000001B3 (1099511628211), per byte: wrapping_mul then xor,
// output decimal signed string. BigInt is required because the 64-bit state
// exceeds JS Number safe-integer range (2^53).

const FNV_OFFSET = 0xCBF29CE484222325n;
const FNV_PRIME = 0x100000001B3n;
const MASK64 = (1n << 64n) - 1n;
const SIGN_BIT = 1n << 63n;
const TWO64 = 1n << 64n;

export function deriveSessionId(accountId) {
  let hash = FNV_OFFSET;
  const bytes = Buffer.from(String(accountId), "utf8");
  for (const b of bytes) {
    hash = (hash * FNV_PRIME) & MASK64; // wrapping multiply, keep low 64 bits
    hash = hash ^ BigInt(b); // xor byte
  }
  // interpret as signed i64 (AG returns i64::to_string())
  if (hash >= SIGN_BIT) hash -= TWO64;
  return hash.toString();
}