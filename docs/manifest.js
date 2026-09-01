// Manifest + push-hash-table parsing, and the push-hash model itself —
// mirrors tools/rl_mkflash.py in the dev repo (v6 layout, manifest v4).
export const MANIFEST_OFF = 0x020000;
export const PUSH_TBL_OFF = 0x020200;
const MANIFEST_MAGIC = 0x4c464c52;   // "RLFL"
const PUSH_TBL_MAGIC = 0x48504c52;   // "RLPH"

// Parse the 4-record manifest from a DataView of the manifest sector.
export function parseManifest(dv) {
  if (dv.getUint32(0, true) !== MANIFEST_MAGIC) return null;
  const version = dv.getUint32(4, true);
  const n = dv.getUint32(8, true);
  const personas = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 80;
    const nameB = new Uint8Array(dv.buffer, dv.byteOffset + o, 8);
    const end = nameB.indexOf(0);
    const name = new TextDecoder().decode(nameB.subarray(0, end < 0 ? 8 : end));
    const nImages = dv.getUint32(o + 16, true);
    const images = [];
    for (let j = 0; j < nImages; j++) {
      const io = o + 20 + j * 12;
      images.push({
        flashOff: dv.getUint32(io, true),
        bytes: dv.getUint32(io + 4, true),
        hwAddr: dv.getUint32(io + 8, true),
      });
    }
    personas.push({ name, images });
  }
  return { version, personas };
}

export function parsePushTable(dv) {
  if (dv.getUint32(0, true) !== PUSH_TBL_MAGIC) return null;
  const n = dv.getUint32(4, true);
  const hashes = [];
  for (let i = 0; i < n; i++) hashes.push(dv.getBigUint64(8 + 8 * i, true));
  return hashes;
}

// The hash rl_bulk_rx accumulates over a persona's push — a port of
// rl_mkflash.py push_hash(), which mirrors the HDL exactly:
//   h = rotl64(h,1) ^ ((((addr << 16) | (hi << 8) | lo) + seq) mod 2^64)
// seq = global 16-bit wrapping halfword count; addr re-anchors per 1024-byte
// chunk (the firmware pushes one frame per chunk).
export function pushHash(images) {
  const M = (1n << 64n) - 1n;
  let h = 0n;
  let seq = 0;
  for (const { hwAddr, data } of images) {
    for (let c0 = 0; c0 < data.length; c0 += 1024) {
      let addr = (hwAddr + (c0 >> 1)) & 0xffffff;
      const end = Math.min(c0 + 1024, data.length);
      for (let j = c0; j < end - 1; j += 2) {
        const v = (BigInt(addr) << 16n | BigInt((data[j + 1] << 8) | data[j]))
                  + BigInt(seq);
        h = (((h << 1n) | (h >> 63n)) & M) ^ (v & M);
        addr = (addr + 1) & 0xffffff;
        seq = (seq + 1) & 0xffff;
      }
    }
  }
  return h;
}
