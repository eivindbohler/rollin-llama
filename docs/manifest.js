// Manifest + push-hash-table parsing, the push-hash model itself, and where
// the board keeps each persona's data: manifest v4 (maps v6 / v7, up to
// four records) and manifest v5 (map v8, five records: mt32, cm32l,
// sc55mk1, sc55mk2, gs2k). The record layout is the same in both; v8's
// flash offsets are 32-bit and may lie in the W25Q256's upper 16 MB.
export const MANIFEST_OFF = 0x020000;
export const PUSH_TBL_OFF = 0x020200;
// "RLFT": per persona the CRC-32 (zlib) and length of its
// firmware-table image, i.e. the MU2000 control tables; { 0, 0 } = none.
export const FWTAB_TBL_OFF = 0x020600;
const FWTAB_MAGIC = 0x54464c52;            // 'RLFT'
const MANIFEST_MAGIC = 0x4c464c52;   // "RLFL"
const PUSH_TBL_MAGIC = 0x48504c52;   // "RLPH"
const MANIFEST_VERSION_MAX = 5;      // 5: up to five records (gs2k); same 80-byte record
export const MAX_PERSONAS = 5;       // firmware RL_MAX_PERSONAS
const MAX_IMAGES = 4;                // firmware RL_MAX_IMAGES: more and it zeroes the manifest
const RECORD = 80;                   // record stride, not the 76 bytes of fields
export const MANIFEST_LEN = 12 + MAX_PERSONAS * RECORD;
export const PUSH_TBL_LEN = 8 + 8 * MAX_PERSONAS;

// Flash offsets from UPPER_BASE up are the second 16 MB of the 32 MB part,
// which the bootrom (PICOBOOT READ/WRITE/ERASE, XIP, the hash and erase
// stubs) cannot address: it sends 3-byte addresses, so an upper offset
// silently wraps onto the lower half. Those regions go through the flash4
// stub (stubs.js) instead.
export const UPPER_BASE = 0x1000000;
// An image with this hw address is read in place by the firmware (the gs2k
// control tables) and never pushed: it is not part of the persona's push
// hash, the same as in the image builder and the firmware.
export const FW_TABLE_HW = 0xFF0000;

// Parse the manifest from a DataView of the manifest sector. Returns
// { version, personas: [{ name, bitOff, bitBytes, images }] } or null when
// there is no manifest (or it is one the firmware would refuse as well).
export function parseManifest(dv) {
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== MANIFEST_MAGIC) return null;
  const version = dv.getUint32(4, true);
  const n = dv.getUint32(8, true);
  if (version > MANIFEST_VERSION_MAX || n > MAX_PERSONAS || 12 + n * RECORD > dv.byteLength) return null;
  const personas = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * RECORD;
    const nameB = new Uint8Array(dv.buffer, dv.byteOffset + o, 8);
    const end = nameB.indexOf(0);
    const name = new TextDecoder().decode(nameB.subarray(0, end < 0 ? 8 : end));
    const nImages = dv.getUint32(o + 16, true);
    if (nImages > MAX_IMAGES) return null;
    const images = [];
    for (let j = 0; j < nImages; j++) {
      const io = o + 20 + j * 12;
      images.push({
        flashOff: dv.getUint32(io, true),
        bytes: dv.getUint32(io + 4, true),
        hwAddr: dv.getUint32(io + 8, true),
      });
    }
    personas.push({
      name, images,
      bitOff: dv.getUint32(o + 8, true),
      bitBytes: dv.getUint32(o + 12, true),
    });
  }
  return { version, personas };
}

// The RLPH table: one expected push hash per manifest record, same order.
// -> [{ crc, bytes }] in manifest order, or null when the image has no table
export function parseFwTables(dv) {
  if (dv.byteLength < 16 || dv.getUint32(0, true) !== FWTAB_MAGIC || dv.getUint32(4, true) !== 1) return null;
  const n = Math.min(dv.getUint32(8, true), MAX_PERSONAS), out = [];
  for (let p = 0; p < n && 16 + 8 * p + 8 <= dv.byteLength; p++)
    out.push({ crc: dv.getUint32(16 + 8 * p, true), bytes: dv.getUint32(20 + 8 * p, true) });
  return out;
}

export function parsePushTable(dv) {
  if (dv.byteLength < 8 || dv.getUint32(0, true) !== PUSH_TBL_MAGIC) return null;
  const n = dv.getUint32(4, true);
  if (n > MAX_PERSONAS || 8 + 8 * n > dv.byteLength) return null;
  const hashes = [];
  for (let i = 0; i < n; i++) hashes.push(dv.getBigUint64(8 + 8 * i, true));
  return hashes;
}

// ---- where the data lives ----------------------------------------------------
// True when any byte of [off, off + n) lies in the upper 16 MB.
export const isUpper = (off, n = 1) => off + n > UPPER_BASE;
// The images a persona's push hash (its RLPH entry) covers, in manifest order.
export const pushedImages = rec => rec.images.filter(im => im.hwAddr !== FW_TABLE_HW);
// True when any of these images reaches into the upper half: its hash then
// has to come from the flash4 stub, which addresses the whole part.
export const hasUpper = images => images.some(im => im.bytes && isUpper(im.flashOff, im.bytes));

const SECTOR = 0x1000;
const down = v => v - (v % SECTOR);
const up = v => down(v + SECTOR - 1);
function merge(spans) {
  const out = [];
  for (const [lo, hi] of spans.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// Every flash range a persona image occupies, whole 4 KB sectors, merged:
// [[lo, hi], ...]. This is where ROM data lives.
export function imageExtents(man) {
  const spans = [];
  for (const p of man?.personas ?? [])
    for (const im of p.images) if (im.bytes) spans.push([down(im.flashOff), up(im.flashOff + im.bytes)]);
  return merge(spans);
}

// What "erase all ROMs" erases: per flash half, the span from the first to
// the last image extent — so stale ROM bytes between the images go too —
// with every bitstream cut out, from its start up to the next image (map
// v8 keeps the gs2k bitstream between the SC-55 mk1 data and the gs2k
// control tables), and the firmware / manifest / settings block below
// 0x030000 never included. Throws when a bitstream overlaps an image (a
// layout that cannot be erased safely). Sorted [[lo, hi], ...], 4 KB aligned,
// none crossing UPPER_BASE.
export function romEraseSpans(man) {
  const ext = imageExtents(man);
  if (!ext.length) return [];
  const keep = [[0, 0x030000]];
  for (const p of man.personas) {
    if (!p.bitBytes) continue;
    const lo = down(p.bitOff), hi = up(p.bitOff + p.bitBytes);
    if (ext.some(([a, b]) => a < hi && lo < b))
      throw new Error('a ROM area overlaps a sound engine on this board');
    const next = ext.find(([a]) => a >= hi);
    keep.push([lo, next ? next[0] : hi]);
  }
  const out = [];
  for (const half of [ext.filter(([a]) => a < UPPER_BASE), ext.filter(([a]) => a >= UPPER_BASE)]) {
    if (!half.length) continue;
    let pieces = [[half[0][0], half[half.length - 1][1]]];
    for (const [klo, khi] of keep)
      pieces = pieces.flatMap(([a, b]) => (khi <= a || b <= klo) ? [[a, b]]
        : [[a, Math.min(b, klo)], [Math.max(a, khi), b]].filter(([x, y]) => y > x));
    out.push(...pieces);
  }
  return merge(out);
}

// The hash the FPGA accumulates over a persona's push, exactly as the
// gateware computes it:
//   h = rotl64(h,1) ^ ((((addr << 16) | (hi << 8) | lo) + seq) mod 2^64)
// seq = global 16-bit wrapping halfword count; addr re-anchors per 1024-byte
// chunk (the firmware pushes one frame per chunk). Computed in two 32-bit
// halves (a BigInt per halfword made a 7 MB image take seconds): the term
// is at most 2^40 + 2^17, so its low word is t mod 2^32 with t below 2^33
// and its high word is addr >> 16 plus the carry out of t. Returns a BigInt,
// comparable with parsePushTable()'s entries.
export function pushHash(images) {
  let lo = 0, hi = 0, seq = 0;
  for (const { hwAddr, data } of images) {
    for (let c0 = 0; c0 < data.length; c0 += 1024) {
      let addr = (hwAddr + (c0 >> 1)) & 0xffffff;
      const end = Math.min(c0 + 1024, data.length);
      for (let j = c0; j < end - 1; j += 2) {
        const t = (addr & 0xffff) * 65536 + ((data[j + 1] << 8) | data[j]) + seq;
        const vhi = (addr >>> 16) + (t > 0xffffffff ? 1 : 0);
        const rlo = ((lo << 1) | (hi >>> 31)) >>> 0;
        const rhi = ((hi << 1) | (lo >>> 31)) >>> 0;
        lo = (rlo ^ (t >>> 0)) >>> 0;
        hi = (rhi ^ vhi) >>> 0;
        addr = (addr + 1) & 0xffffff;
        seq = (seq + 1) & 0xffff;
      }
    }
  }
  return (BigInt(hi) << 32n) | BigInt(lo);
}
