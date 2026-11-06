// GS2K pack builder: converts the user's own Yamaha MU2000 ROM dumps into the
// gs2k persona's data (samples.bin + ctl.bin), in the browser, so no Yamaha
// byte ever ships with the flasher. This file holds only addresses and sizes
// inside the ROMs and our own formats (the "GS2K" control blob); every
// output byte is read from the supplied files at run time.
//
// Default subset (as the reference build): the GS capital and variation bank
// rows, the GS SFX variation rows, and the GS drum kits without the SFX kit.
//
// The effects section of ctl.bin ("MEG2") is built here too, from raw slices
// of the program ROM. `opts.meg` overrides the section (tests only).

export const GS2K_ROMS = [
  { set: 'gs2k', name: 'mu2000-v2.01-h.bin', label: 'Program ROM (high)', size: 2097152, sha1: '00d008b6a2536a71681ce2f4fd1a5853406f82f2' },
  { set: 'gs2k', name: 'mu2000-v2.01-l.bin', label: 'Program ROM (low)',  size: 2097152, sha1: 'fd8fe6a5cbba028d847453c004cb2dcf9ba02013' },
  { set: 'gs2k', name: 'xv364a0.ic49',       label: 'Wave ROM 1 (IC49)',  size: 8388608, sha1: 'e7098246b33c3cf22ed8cc15ed6383f8a06d17e9' },
  { set: 'gs2k', name: 'xv365a0.ic50',       label: 'Wave ROM 2 (IC50)',  size: 8388608, sha1: 'd45a2e85859e05046f3ede8317a9bb0b88898116' },
  { set: 'gs2k', name: 'xw848a0.ic53',       label: 'Wave ROM 3 (IC53)',  size: 8388608, sha1: '9e8b55c2cbac3f69cc0b17aeaf02053145bfaeda' },
  { set: 'gs2k', name: 'xw849a0.ic54',       label: 'Wave ROM 4 (IC54)',  size: 8388608, sha1: '7670d672e24d6388fa92799175f35869a140c451' },
];

const CTL_MAGIC = [0x47, 0x53, 0x32, 0x4b];  // 'GS2K'
const CTL_VERSION = 6;                        // 6: effects section MEG2
const CTL_HDR_LEN = 0x50;

const PROG_LEN = 0x400000;        // program image as the CPU sees it
const WAVE_LEN = 0x2000000;       // wave space: 32 MB of 32-bit words

// Program-ROM addresses (CPU byte order, big-endian fields).
const WT = 0x200af0;              // bank-0 waveform -> byte offset of its first zone header (u16)
const ST = 0x1f55a0;              // zone headers, 16 B each
const N_ZONES = 2901;
const VT = 0x200ee0;              // voice records: u16 + 10-char name + u16, then n x 84-byte elements
const NW = (VT - WT) >> 1;        // bank-0 waveform count
const VOICE_END = 0x2b0000;
const BM = 0x267f50;              // bank map: rows x 128 programs x u32 (voice offset / 2 from VT)
const LSB_ROW = 0x2839d0;         // GS bank MSB -> variation row (128 x u8)
const KIT_MAPS = 0x292250;        // kit -> u32 pointer to a 128 x u16 note map
const KIT_PROG = 0x292340;        // program -> kit (128 x u8)
const DRUM_VOICES = 0x283dd0;     // base of the note maps' offsets; 42-byte drum records
const DRUM_LEN = 42;
const DRUM_HDR = 30;              // the drum record's embedded sample header (12 B)
const CURVES = 0x23ced0;          // key-scaling curves, 128 B each
// The firmware's conversion tables, in ctl.bin 'tables' order: name, address, bytes.
// TL/FR/PR are u16 (big-endian in the ROM, little-endian in ctl.bin);
// PTR gets a 129th entry of 255.
const TABLES = [
  ['TL', 0x1e5b58, 256], ['L', 0x1e6818, 129], ['V', 0x1e6798, 128], ['VC', 0x1e5e5e, 896],
  ['PT', 0x1e6b90, 129], ['PU', 0x1e6c11, 129], ['TS', 0x1b99b8, 128], ['EP', 0x1e68dc, 16],
  ['EPN', 0x1e68eb, 128], ['SA', 0x1f4db8, 128], ['SD', 0x1f4e38, 128], ['FR', 0x1e5c58, 128],
  ['VD', 0x1e5d58, 256], ['PR', 0x1e6c94, 128], ['LD', 0x1e6596, 256], ['LC', 0x1e62e0, 32],
  ['AT', 0x1e54a4, 64], ['RT', 0x1e54e4, 128], ['VR', 0x1e6470, 160], ['VDT', 0x1e57d4, 128],
  ['DLT', 0x1e55d4, 256], ['TMOD', 0x1e6370, 128], ['KF', 0x1e5e58, 6], ['PL', 0x1f2198, 128],
  ['PTR', 0x1bbad0, 129], ['FT', 0x1e5cd8, 128], ['SR', 0x1f4eb8, 128],
];

// Subset selection (our choice): GS kit programs without the SFX kit (56);
// GS SFX variation rows 201-210; row 76 is the all-"Silence" row.
const GS_KIT_PROGS = [0, 8, 16, 24, 25, 32, 40, 48];
const SFX_ROWS = [201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
const SILENCE_ROW = 76;

const BPS = [2, 1.5, 1, 1];       // bytes per sample by format: 16-bit, 12-bit, 8-bit, 8-bit delta

// ---------------------------------------------------------------- helpers

const u8of = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
const even = (u8) => (u8.byteOffset & 1 ? u8.slice() : u8);          // for Uint16Array views
const view16 = (u8) => new Uint16Array(u8.buffer, u8.byteOffset, u8.length >> 1);
const floor4 = (x) => x - (((x % 4) + 4) % 4);                          // Python x & ~3, any sign
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

class Buf {
  constructor(n = 1 << 16) { this.u8 = new Uint8Array(n); this.length = 0; }
  reserve(n) {
    if (this.length + n <= this.u8.length) return;
    let c = this.u8.length * 2;
    while (c < this.length + n) c *= 2;
    const t = new Uint8Array(c); t.set(this.u8.subarray(0, this.length)); this.u8 = t;
  }
  push(bytes) { this.reserve(bytes.length); this.u8.set(bytes, this.length); this.length += bytes.length; }
  byte(v) { this.reserve(1); this.u8[this.length++] = v; }
  u16le(v) {
    if (!(v >= 0 && v <= 0xffff)) throw new RangeError(`u16 out of range: ${v}`);
    this.reserve(2); this.u8[this.length++] = v & 0xff; this.u8[this.length++] = v >>> 8;
  }
  u32le(v) {
    if (!(v >= 0 && v <= 0xffffffff)) throw new RangeError(`u32 out of range: ${v}`);
    this.reserve(4);
    for (let i = 0; i < 4; i++) this.u8[this.length++] = (v >>> (8 * i)) & 0xff;
  }
  u32be(v) {
    this.reserve(4);
    for (let i = 3; i >= 0; i--) this.u8[this.length++] = (v >>> (8 * i)) & 0xff;
  }
  pad4() { while (this.length & 3) this.byte(0); }
  bytes() { return this.u8.slice(0, this.length); }
}

// Program image: the two 16-bit halves interleaved word by word, bytes
// swapped within each halfword: P[4j..4j+3] = h[2j+1] h[2j] l[2j+1] l[2j].
function progImage(h, l) {
  const P = new Uint8Array(PROG_LEN);
  for (let j = 0, o = 0; o < PROG_LEN; j += 2, o += 4) {
    P[o] = h[j + 1]; P[o + 1] = h[j]; P[o + 2] = l[j + 1]; P[o + 3] = l[j];
  }
  return P;
}

// Wave space: 32-bit little-endian words; word k = ic49[2k..2k+1] +
// ic50[2k..2k+1] for the first 16 MB, ic53/ic54 likewise above. Read in
// place (no 32 MB image): copy wave words [a, b) to dst at dOff, halfword
// units copied as stored (endian-neutral). Ranges are dword aligned by
// construction (floor4 bounds, sums of whole dwords).
function waveReader(f) {
  const p16 = [[f['xv364a0.ic49'], f['xv365a0.ic50']], [f['xw848a0.ic53'], f['xw849a0.ic54']]]
    .map(([a, b]) => [view16(even(a)), view16(even(b))]);
  return function copy(dst, dOff, a, b) {
    if ((a | b | dOff) & 3) throw new Error('gs2k: unaligned sample range');
    const d16 = view16(dst);
    let o = dOff >>> 1;
    for (let w = a >>> 2, we = b >>> 2; w < we; w++) {
      const [A16, B16] = p16[w >>> 22], k = w & 0x3fffff;
      d16[o++] = A16[k]; d16[o++] = B16[k];
    }
  };
}

// Voice records -> Map(offset -> element count). A record ends where the next
// one's name (10 printable characters, not all blank, u16 lead < 0x1000)
// appears 1..8 elements later; the walk stops at the first record without one.
function walkVoices(P) {
  const u16 = (o) => (P[o] << 8) | P[o + 1];
  const isName = (o) => {
    let blank = true;
    for (let i = 0; i < 10; i++) {
      const c = P[o + i];
      if (!(c >= 0x20 && c <= 0x7e)) return false;
      if (c !== 0x20) blank = false;
    }
    return !blank;
  };
  const vinfo = new Map();
  let p = VT;
  while (p < VOICE_END) {
    if (!isName(p + 2)) break;
    let next = -1, ne = 0;
    for (let n = 1; n <= 8; n++) {
      const q = p + 14 + 84 * n;
      if (isName(q + 2) && u16(q) < 0x1000) { next = q; ne = n; break; }
    }
    if (next < 0) break;
    vinfo.set(p, ne); p = next;
  }
  return vinfo;
}

// ---------------------------------------------------------------- the pack

// Two passes, as the reference: pass 1 (reloc null) collects every zone's
// sample byte range, merge() joins them into the relocated sample blob, and
// pass 2 rebuilds everything with the relocated word addresses.
class Pack {
  constructor(P, vinfo, reloc = null) {
    this.P = P; this.vinfo = vinfo;
    this.ranges = reloc ? null : [];
    this.reloc = reloc;               // [{ a, b, dst }], sorted, disjoint
    this.hdrs = new Buf(); this.voices = new Buf();
    this.vmap = new Map(); this.vdir = []; this.chains = new Map();
    this.curveIds = new Set(); this.elements = 0; this.kitdir = [];
  }
  u16(o) { return (this.P[o] << 8) | this.P[o + 1]; }
  u32(o) { return be32(this.P, o); }

  // Sample span with interpolation margins, dword aligned (keeps the 12-bit
  // nibble phase): [addr*4 - start*bps - 1.5, addr*4 + loop*bps + 16),
  // clamped to the wave space (the zone at word 0 would start at -4).
  sample(fmt, addr, start, loop) {
    const bps = BPS[fmt];
    const lo = Math.max(0, floor4(addr * 4 - Math.trunc(start * bps + 1.5)));
    const hi = Math.min(WAVE_LEN, floor4(addr * 4 + Math.trunc(loop * bps) + 16 + 3));
    if (this.ranges) { this.ranges.push([lo, hi]); return 0; }
    const R = this.reloc;
    let i0 = 0, i1 = R.length - 1, hit = -1;
    while (i0 <= i1) {                    // last range with a <= lo
      const m = (i0 + i1) >> 1;
      if (R[m].a <= lo) { hit = m; i0 = m + 1; } else i1 = m - 1;
    }
    if (hit < 0 || hi > R[hit].b) throw new Error(`gs2k: sample range 0x${lo.toString(16)} not packed`);
    return Math.floor((R[hit].dst + (addr * 4 - R[hit].a)) / 4);
  }

  merge(copyWave) {
    const rs = this.ranges.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const merged = [];
    for (const [a, b] of rs) {
      const m = merged[merged.length - 1];
      if (m && a <= m[1]) m[1] = Math.max(m[1], b); else merged.push([a, b]);
    }
    const reloc = []; let total = 0;
    for (const [a, b] of merged) { reloc.push({ a, b, dst: total }); total += b - a; }
    const samples = new Uint8Array(total);
    for (const r of reloc) copyWave(samples, r.dst, r.a, r.b);
    this.reloc = reloc;
    this.ranges = null;
    return samples;
  }

  // One 16-byte zone header, relocated (bits 0-24 of the last word = the
  // loop-start word address). Never deduplicated: a chain is walked by index.
  header(raw) {
    const st = be32(raw, 4), lp = be32(raw, 8), ad = be32(raw, 12);
    const na = this.sample(ad >>> 30, ad & 0x1ffffff, st & 0xffffff, lp & 0xffffff);
    const idx = this.hdrs.length >> 4;
    this.hdrs.push(raw.subarray(0, 12));
    this.hdrs.u32be(((ad & ~0x1ffffff) | na) >>> 0);
    return idx;
  }

  // Waveform w's zone chain -> index of its first relocated header.
  chain(w) {
    const got = this.chains.get(w);
    if (got !== undefined) return got;
    let zi = this.u16(WT + 2 * w) >> 4, first = -1;
    for (;;) {
      const o = ST + 16 * zi, raw = this.P.subarray(o, o + 16);
      const idx = this.header(raw);
      if (first < 0) first = idx;
      const b3 = raw[3]; zi++;
      if ((b3 & 0x80) || (b3 & 0x7f) === 127 || zi >= N_ZONES) break;
    }
    this.chains.set(w, first);
    return first;
  }

  // Voice record -> byte offset in the voices blob; element waveform ids are
  // rewritten to the packed header index (bank-0 waveforms only, else 7f 7f).
  voice(off) {
    const got = this.vmap.get(off);
    if (got !== undefined) return got;
    const ne = this.vinfo.get(off);
    const rec = this.P.slice(off, off + 14 + 84 * ne);
    for (let e = 0; e < ne; e++) {
      const eo = 14 + 84 * e, wid = (rec[eo] << 7) | rec[eo + 1];
      if (wid < NW && (wid >> 7) < 4) {
        const h = this.chain(wid); rec[eo] = (h >> 7) & 0x7f; rec[eo + 1] = h & 0x7f;
      } else {
        rec[eo] = 0x7f; rec[eo + 1] = 0x7f;
      }
      this.elements++;
      this.curveIds.add((rec[eo + 42] << 8) | rec[eo + 43]);   // cutoff key-scaling curve
      this.curveIds.add((rec[eo + 64] << 8) | rec[eo + 65]);   // level key-scaling curve
    }
    const idx = this.voices.length;
    this.vmap.set(off, idx); this.voices.push(rec); this.vdir.push([idx, ne]);
    return idx;
  }
}

function build(pk) {
  const P = pk.P;
  const rowSet = new Set([0]);
  for (let l = 1; l < 64; l++) rowSet.add(P[LSB_ROW + l]);
  for (const r of SFX_ROWS) rowSet.add(r);
  rowSet.delete(SILENCE_ROW);
  const rows = [...rowSet].sort((x, y) => x - y);
  const bank = new Map();
  for (const r of rows) {
    const progs = [];
    for (let p = 0; p < 128; p++) {
      const off = VT + pk.u32(BM + (r * 128 + p) * 4) * 2;
      progs.push(pk.vinfo.has(off) ? pk.voice(off) : 0xffffffff);
    }
    bank.set(r, progs);
  }
  const kits = [...new Set(GS_KIT_PROGS.map((p) => P[KIT_PROG + p]))].sort((x, y) => x - y);
  const kitblob = new Buf(); const dmap = new Map(); const kitdir = [];
  for (const k of kits) {
    const mp = pk.u32(KIT_MAPS + 4 * k), notes = [];
    for (let n = 0; n < 128; n++) {
      const off = pk.u16(mp + 2 * n);
      if (off === 0xffff) { notes.push(0xffff); continue; }
      if (!dmap.has(off)) {
        const rec = P.slice(DRUM_VOICES + off, DRUM_VOICES + off + DRUM_LEN);
        const raw = new Uint8Array(16); raw.set(rec.subarray(DRUM_HDR, DRUM_LEN), 4);
        const hi = pk.header(raw);
        rec.set(pk.hdrs.u8.subarray(hi * 16 + 4, hi * 16 + 16), DRUM_HDR);
        dmap.set(off, kitblob.length); kitblob.push(rec);
      }
      notes.push(dmap.get(off));
    }
    kitdir.push([k, kitblob.length]);
    for (const v of notes) kitblob.u16le(v);
  }
  pk.kitdir = kitdir;
  return { rows, bank, kits, kitblob: kitblob.bytes() };
}

function tablesBlob(P) {
  const out = new Buf(8192);
  for (const [name, addr, n] of TABLES) {
    if (name === 'TL' || name === 'FR' || name === 'PR') {
      for (let i = 0; i < (n >> 1); i++) out.u16le((P[addr + 2 * i] << 8) | P[addr + 2 * i + 1]);
    } else if (name === 'PTR') {
      out.push(P.subarray(addr, addr + 128)); out.byte(0xff);
    } else {
      out.push(P.subarray(addr, addr + n));
    }
  }
  return out.bytes();
}

// u32 ndir, u32 ncurves, u16 dir[ndir] (0xffff = not packed), pad to 4,
// then ncurves x 128 signed bytes.
function curvesBlob(P, idSet) {
  const ids = [...idSet].sort((x, y) => x - y);
  const ndir = ids[ids.length - 1] + 1;
  const dir = new Array(ndir).fill(0xffff);
  ids.forEach((cid, i) => { dir[cid] = i; });
  const out = new Buf(8 + 2 * ndir + 128 * ids.length + 4);
  out.u32le(ndir); out.u32le(ids.length);
  for (const v of dir) out.u16le(v);
  out.pad4();
  for (const cid of ids) out.push(P.subarray(CURVES + 128 * cid, CURVES + 128 * cid + 128));
  return out.bytes();
}

// ---------------------------------------------------------------- effects section
// "MEG2": fixed layout, raw ROM bytes (big-endian, as in the ROM) — the GS
// reverb/chorus level table, then the reverb-time routine's step table, line
// rows, the two GS time maps, its constant list and its gain pairs. The
// firmware reads it in place.
const MEG2_SLICES = [            // [section offset, ROM address, bytes]
  [8,   0x18aa98, 128],          // EL
  [136, 0x18f028, 70],           // T
  [208, 0x18f479, 30],           // line rows
  [240, 0x1b973c, 256],          // time maps
  [496, 0x16b606, 48],           // constant list
  [544, 0x18f06e, 1024],         // gain pairs
];
const MEG2_LEN = 1568;
function meg2Section(P) {
  const s = new Uint8Array(MEG2_LEN);
  s.set([0x4d, 0x45, 0x47, 0x32], 0);                            // 'MEG2'
  new DataView(s.buffer).setUint16(4, 1, true);
  new DataView(s.buffer).setUint16(6, MEG2_LEN, true);
  for (const [o, a, n] of MEG2_SLICES) s.set(P.subarray(a, a + n), o);
  return s;
}

// ---------------------------------------------------------------- entry point

// files: { name: Uint8Array } for the six GS2K_ROMS entries (identify them by
// SHA-1 first; only presence and sizes are checked here).
// opts.meg: override for the ctl.bin effects section (default: MEG2 built from the program ROM).
// Returns { samples, ctl, info }.
export async function buildGs2kPack(files, opts = {}) {
  const f = {};
  for (const r of GS2K_ROMS) {
    const d = files[r.name];
    if (!d) throw new Error(`gs2k: missing ${r.name}`);
    f[r.name] = u8of(d);
    if (f[r.name].length !== r.size)
      throw new Error(`gs2k: ${r.name} is ${f[r.name].length} bytes, expected ${r.size}`);
  }
  const P = progImage(f['mu2000-v2.01-h.bin'], f['mu2000-v2.01-l.bin']);
  const meg = opts.meg ? u8of(opts.meg) : meg2Section(P);
  const vinfo = walkVoices(P);

  const pk1 = new Pack(P, vinfo);                       // pass 1: ranges only
  build(pk1);
  const samples = pk1.merge(waveReader(f));
  const pk = new Pack(P, vinfo, pk1.reloc);             // pass 2: relocated
  const { rows, bank, kits, kitblob } = build(pk);

  const banks = new Buf(rows.length * 516);
  for (const r of rows) { banks.u32le(r); for (const v of bank.get(r)) banks.u32le(v); }
  const kitdir = new Buf(8 * pk.kitdir.length);
  for (const [k, o] of pk.kitdir) { kitdir.u32le(k); kitdir.u32le(o); }
  const vdir = new Buf(8 * pk.vdir.length);
  for (const [o, n] of pk.vdir.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) { vdir.u32le(o); vdir.u32le(n); }

  const parts = [
    ['voices', pk.voices.bytes()],
    ['banks', banks.bytes()],
    ['headers', pk.hdrs.bytes()],
    ['kitdir', kitdir.bytes()],
    ['kits', kitblob],
    ['kitprog', P.slice(KIT_PROG, KIT_PROG + 128)],
    ['lsbrow', P.slice(LSB_ROW, LSB_ROW + 128)],
    ['tables', tablesBlob(P)],
    ['curves', curvesBlob(P, pk.curveIds)],
    ['vdir', vdir.bytes()],
    ['meg', meg],
  ];
  const offs = {}; let off = CTL_HDR_LEN;
  for (const [name, blob] of parts) { offs[name] = { off, len: blob.length }; off += (blob.length + 3) & ~3; }

  const ctl = new Uint8Array(off);
  ctl.set(CTL_MAGIC, 0);
  const dv = new DataView(ctl.buffer);
  const hdrWords = [
    CTL_VERSION,
    offs.voices.off, offs.voices.len,
    offs.banks.off, rows.length,
    offs.headers.off, pk.hdrs.length >> 4,
    offs.kitdir.off, pk.kitdir.length,
    offs.kits.off, kitblob.length,
    offs.kitprog.off, offs.lsbrow.off, offs.tables.off, offs.curves.off,
    offs.vdir.off, pk.vdir.length,
    offs.meg.off, offs.meg.len,
  ];
  hdrWords.forEach((v, i) => dv.setUint32(4 + 4 * i, v, true));
  for (const [name, blob] of parts) ctl.set(blob, offs[name].off);

  const info = {
    version: CTL_VERSION,
    rows, kits,
    voices: pk.vmap.size, elements: pk.elements,
    zoneHeaders: pk.hdrs.length >> 4,
    sampleRanges: pk.reloc.length, sampleBytes: samples.length,
    curves: pk.curveIds.size,
    ctlBytes: ctl.length, megBytes: meg.length,
    parts: offs,
  };
  return { samples, ctl, info };
}
