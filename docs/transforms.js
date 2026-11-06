// Inverse data transforms: reconstruct the ORIGINAL ROM-file bytes from the
// derived images the board stores, so each file can be verified against its
// reference SHA-1 (and, forward, so uploads can be derived in-browser).

// SC-55 wave-ROM address/data line permutation (identical for mk1 and mk2).
const AA = [2, 0, 3, 4, 1, 9, 13, 10, 18, 17, 6, 15, 11, 16, 8, 5, 12, 7, 14, 19];
const DD = [2, 0, 4, 5, 7, 6, 3, 1];

const dFwd = new Uint8Array(256);   // scrambled byte -> descrambled byte
const dInv = new Uint8Array(256);
for (let s = 0; s < 256; s++) {
  let d = 0;
  for (let j = 0; j < 8; j++) if (s & (1 << DD[j])) d |= 1 << j;
  dFwd[s] = d; dInv[d] = s;
}
function permAddr(i) {
  let a = i & ~0xfffff;
  for (let j = 0; j < 20; j++) if (i & (1 << j)) a |= 1 << AA[j];
  return a;
}

// descrambled -> original (rescramble): orig[A(i)] = Dinv(desc[i])
export function scrambleWave(desc) {
  const out = new Uint8Array(desc.length);
  for (let i = 0; i < desc.length; i++) out[permAddr(i)] = dInv[desc[i]];
  return out;
}
// original -> descrambled (what the board stores)
export function unscrambleWave(src) {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = dFwd[src[permAddr(i)]];
  return out;
}

// MT-32/CM-32L PCM byte-pair shuffle (R5_SHUFFLE):
//   v = {lo[7], hi[6], lo[6:0], hi[5:0], hi[7]}, stored LE per halfword.
export function shufflePcm(orig) {
  const out = new Uint8Array(orig.length);
  for (let i = 0; i < orig.length; i += 2) {
    const lo = orig[i], hi = orig[i + 1];
    const v = ((lo >> 7) & 1) << 15 | ((hi >> 6) & 1) << 14 |
              (lo & 0x7f) << 7 | (hi & 0x3f) << 1 | (hi >> 7) & 1;
    out[i] = v & 0xff; out[i + 1] = v >> 8;
  }
  return out;
}
export function unshufflePcm(img) {
  const out = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i += 2) {
    const v = img[i] | (img[i + 1] << 8);
    out[i]     = ((v >> 15) & 1) << 7 | (v >> 7) & 0x7f;
    out[i + 1] = ((v >> 14) & 1) << 6 | (v >> 1) & 0x3f | (v & 1) << 7;
  }
  return out;
}

// Reconstruct ORIGINAL files from a persona's image list ({hwAddr,data}).
// Tolerant of a PARTIAL image list (during incremental verification): only
// files whose backing images are all present appear in the result.
export function extractOriginals(personaId, images) {
  const byHw = hw => images.find(im => im.hwAddr === hw)?.data;
  const slice = (u8, a, b) => u8.subarray(a, b);
  const out = {};
  switch (personaId) {
    case 'mt32': {
      const sdram = byHw(0x000000), ctl = byHw(0x700000);
      if (sdram) out['MT32_PCM.ROM'] = unshufflePcm(sdram);
      if (ctl) out['MT32_CONTROL.ROM'] = ctl;
      break;
    }
    case 'cm32l': {
      const lo = byHw(0x000000), hi = byHw(0x040000), ctl = byHw(0x700000);
      if (lo && hi) {
        const pcm = new Uint8Array(lo.length + hi.length);
        pcm.set(unshufflePcm(lo), 0);
        pcm.set(unshufflePcm(hi), lo.length);
        out['CM32L_PCM.ROM'] = pcm;
      }
      if (ctl) out['CM32L_CONTROL.ROM'] = ctl;
      break;
    }
    case 'sc55mk1': {
      const sdram = byHw(0x000000);
      if (sdram) {
        out['sc55mk1_waverom1.bin'] = scrambleWave(slice(sdram, 0, 0x100000));
        out['sc55mk1_waverom2.bin'] = scrambleWave(slice(sdram, 0x100000, 0x200000));
        out['sc55mk1_waverom3.bin'] = scrambleWave(slice(sdram, 0x200000, 0x300000));
      }
      if (byHw(0x280000)) out['sc55mk1_rom2.bin'] = byHw(0x280000);      // images before 2026-11
      else if (sdram && sdram.length >= 0x340000) out['sc55mk1_rom2.bin'] = slice(sdram, 0x300000, 0x340000);
      if (byHw(0x700000)) out['sc55mk1_rom1.bin'] = byHw(0x700000);
      break;
    }
    case 'sc55mk2': {
      const sdram = byHw(0x000000);
      if (sdram) {
        out['sc55mk2_waverom1.bin'] = scrambleWave(slice(sdram, 0, 0x200000));
        out['sc55mk2_waverom2.bin'] = scrambleWave(slice(sdram, 0x200000, 0x300000));
        out['sc55mk2_rom2.bin'] = slice(sdram, 0x300000, 0x380000);
      }
      if (byHw(0x700000)) out['sc55mk2_rom1.bin'] = byHw(0x700000);
      if (byHw(0x710000)) out['sc55mk2_rom_sm.bin'] = byHw(0x710000);
      break;
    }
  }
  return out;
}

// Per-file read plan: which byte ranges of which images back each ROM, and
// which inverse transform reconstructs the original file. Files partition
// the images, so file-granular reads still read every byte exactly once.
//   parts: [{ hw, off, len }]  — image hwAddr + byte offset + length
//   xform: 'raw' | 'unshuffle' | 'scramble'  (applied per part, concatenated)
// `rec` (the persona's manifest record) picks between layouts where the
// board's image says which one it has: the SC-55 mk1's ROM 2 was its own
// image at hw 0x280000 until 2026-11 and now follows the waves in image 0
// (same flash bytes either way).
export function filePlan(personaId, rec = null) {
  switch (personaId) {
    case 'mt32': return {
      'MT32_CONTROL.ROM': { parts: [{ hw: 0x700000, off: 0, len: 65536 }], xform: 'raw' },
      'MT32_PCM.ROM':     { parts: [{ hw: 0x000000, off: 0, len: 524288 }], xform: 'unshuffle' },
    };
    case 'cm32l': return {
      'CM32L_CONTROL.ROM': { parts: [{ hw: 0x700000, off: 0, len: 65536 }], xform: 'raw' },
      'CM32L_PCM.ROM':     { parts: [{ hw: 0x000000, off: 0, len: 524288 },
                                     { hw: 0x040000, off: 0, len: 524288 }], xform: 'unshuffle' },
    };
    case 'sc55mk1': return {
      'sc55mk1_rom1.bin':     { parts: [{ hw: 0x700000, off: 0, len: 32768 }], xform: 'raw' },
      'sc55mk1_rom2.bin':     { parts: [rec?.images.some(im => im.hwAddr === 0x280000)
                                          ? { hw: 0x280000, off: 0, len: 262144 }
                                          : { hw: 0x000000, off: 0x300000, len: 262144 }], xform: 'raw' },
      'sc55mk1_waverom1.bin': { parts: [{ hw: 0x000000, off: 0x000000, len: 0x100000 }], xform: 'scramble' },
      'sc55mk1_waverom2.bin': { parts: [{ hw: 0x000000, off: 0x100000, len: 0x100000 }], xform: 'scramble' },
      'sc55mk1_waverom3.bin': { parts: [{ hw: 0x000000, off: 0x200000, len: 0x100000 }], xform: 'scramble' },
    };
    case 'sc55mk2': return {
      'sc55mk2_rom1.bin':     { parts: [{ hw: 0x700000, off: 0, len: 32768 }], xform: 'raw' },
      'sc55mk2_rom_sm.bin':   { parts: [{ hw: 0x710000, off: 0, len: 4096 }], xform: 'raw' },
      'sc55mk2_rom2.bin':     { parts: [{ hw: 0x000000, off: 0x300000, len: 0x080000 }], xform: 'raw' },
      'sc55mk2_waverom1.bin': { parts: [{ hw: 0x000000, off: 0x000000, len: 0x200000 }], xform: 'scramble' },
      'sc55mk2_waverom2.bin': { parts: [{ hw: 0x000000, off: 0x200000, len: 0x100000 }], xform: 'scramble' },
    };
    // gs2k (MU2000): no per-file plan. Its six files are COMBINED by the
    // converter (gs2kpack.js) into the sample data and the control tables,
    // so no file maps to a byte range; app.js writes and verifies that
    // persona as a whole.
    case 'gs2k': return {};
  }
  return {};
}

export function applyXform(xform, data) {
  if (xform === 'unshuffle') return unshufflePcm(data);
  if (xform === 'scramble') return scrambleWave(data);
  return data;
}

// Forward direction (original file -> on-board bytes), for uploads. Both
// transforms work per byte-pair / per 1MB block, so deriving the whole file
// and splitting it across parts is equivalent to deriving per part.
export function applyXformFwd(xform, data) {
  if (xform === 'unshuffle') return shufflePcm(data);
  if (xform === 'scramble') return unscrambleWave(data);
  return data;
}
