// EXEC stubs the flasher runs on the board over PICOBOOT (BOOTSEL), beside
// the board-revision one in boardrev.js. Sources + build: stub/ (make
// prints the hex). Both expect the flash in the serial command state the
// connect-time EXIT_XIP leaves (and leave it that way).
//
//   hashPersona  — the push hash rl_bulk_rx accumulates over a persona's
//                  images (the RLPH value, the firmware's own boot check),
//                  computed on the board through quad XIP (2.3 MB/s): 3.9 s
//                  for all four personas against 17 s of USB read-back.
//   blockErase   — flash_range_erase with the 64 KB block command (153 ms
//                  per block measured) instead of the bootrom ERASE's 4 KB
//                  sector erases (559 ms per 64 KB), 3.7x.
//   ledPulse     — leaves the LED breathing amber at 1 Hz: PWM on the red
//                  and green cathodes fed by a DMA ring from a table in
//                  SRAM, paced by a DMA timer, two channels chained in a
//                  loop — no code runs, it lasts until the board reboots.
//                  Only from Connect on: before that the bootrom alone is
//                  running and the LED sits in its passive dim glow. The
//                  stub first releases DMA, PWM and the GPIO bank from
//                  reset: the bootrom leaves them held.
export const STUB_ADDR   = 0x20000400;   // low SRAM, unused by the bootrom in BOOTSEL (boardrev.js uses 0x20000000)
export const PARAM_ADDR  = 0x20000200;
export const RESULT_ADDR = 0x20000300;
const HASH_MARKER  = 0x31485348;         // "HSH1"
const ERASE_MARKER = 0x31535245;         // "ERS1"
const HASH_HEX  = 'f0b5ce4647461825142480b52b88208887b0764980b298472b8804902088744980b298472b8805902088724980b29847049b04009847059b9847a04721226e4b6e491a600b681f3a93430b606c4901200b606c49143d0b606b490b6000236b490b606b4b1a60e0226a4bd2021860f03b1a603522684b08601a601a60674a14682c42fcd014680442f9d118681868c0b202282ad0062004261860053814683442fcd01468250005400442f7d11c68186002201d6004251860013814682c42fcd014680442f9d11868052418680426186801201c601c6015683542fcd015680542f9d11d681d680542f3d1c02400204c4d6405086025604b4ceb2520604a484b4c04262060012008601d604b3d1d6013683342fcd013681d0005400342f7d18022434b0d602360434b08601f68424b52051e68424b1b689bb20393414b1b689b18404a1268520894463f4a12681202120a02926246002a12d1049b9847059b98473a4b3b4a1f603b4b1e603b4b1a603b4b039a1a6007b0c0bcb946b046f0bd029a039915046a46148980225202141b521a624500d962460194944200d90192029a120c90462e4a9146039a5519019a1400188802334019002149414144f20f7f007641174347404e404d44013cf0d10199029a52181202120a0292039a521892b203926246521a9446b3e7c04649460000455800004643000004000240080002400c00024010000240140002400800001814000018f0000018600000182800001800035f000400001821220000f4000018222000a00c0200201002002014020020000200200402002008020020000300204853483104030020080300200c03002001000100';
const ERASE_HEX = 'f8b5182714243b8820880f4980b298473b88060020880d4980b298473b88050020880b4980b298470400b047a8478022084b52021868084b1968d823a047074b074a1a60f8bdc04649460000455800005245000000020020040200200003002045525331';

const LED_HEX   = '2349244b0800244a10b5244c1b68116022680a408242fbd18022214912050a60204921480a600521204a214c11600022204902600c602049203cff3c0c601f491f4c0a6022600d3202601e48093a02601d4802601d4a1e4810601e4a13601e4a98181e4a106001201d4a10601d4a1e4810601e4a136080221d4bd20019601d4b1a601d4b1d4a1a601d4b1e4a1a6010bd244100000002002000f0004008c00040140000d0240000d078000540dc400140ff030000880005407c0005408400054080000540e4400140ec400140200400501bb70100c0020050fc0f0000c4020050c8020050d002005009d03f008002005084020050880200508c02005019db3d00000300204c454431';
export const LED_TABLE_ADDR = 0x20002000;  // 4 KB aligned: the DMA read ring wraps on it
const LED_MARKER = 0x3144454c;             // "LED1"

const hex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
const u32s = (...ws) => {
  const a = new Uint8Array(ws.length * 4);
  const v = new DataView(a.buffer);
  ws.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  return a;
};
let loaded = null;                        // which stub currently sits at STUB_ADDR
async function load(pb, which, h) {
  if (loaded === which) return;
  await pb.write(STUB_ADDR, hex(h));
  loaded = which;
}
export function forgetStubs() { loaded = null; }   // call on (re)connect

// images: [{ flashOff, bytes, hwAddr }] in manifest order. Returns the
// 64-bit hash as a BigInt, comparable to parsePushTable()'s entries. The
// work goes to the board in HASH_PIECE-byte EXECs with the running state
// threaded through (an EXEC blocks the link until it returns), so
// `progress(0..1)` moves every ~60 ms.
const HASH_PIECE = 128 * 1024;
export async function hashPersona(pb, images, progress = () => {}, ackTimeoutMs = 20000) {
  if (!images.length) throw new Error('hash stub: no images');
  await load(pb, 'hash', HASH_HEX);
  const total = images.reduce((a, im) => a + im.bytes, 0);
  let lo = 0, hi = 0, seq = 0, done = 0;
  for (const im of images) {
    for (let o = 0; o < im.bytes; o += HASH_PIECE) {
      const n = Math.min(HASH_PIECE, im.bytes - o);
      await pb.write(PARAM_ADDR, u32s(im.flashOff + o, n, (im.hwAddr + (o >> 1)) & 0xffffff, lo, hi, seq));
      await pb.write(RESULT_ADDR, new Uint8Array(16));
      await pb.exec(STUB_ADDR, ackTimeoutMs);
      const dv = await pb.read(RESULT_ADDR, 16);
      if (dv.getUint32(8, true) !== HASH_MARKER) throw new Error('the hash stub did not report back');
      lo = dv.getUint32(0, true); hi = dv.getUint32(4, true); seq = dv.getUint32(12, true);
      done += n;
      progress(done / total);
    }
  }
  return (BigInt(hi) << 32n) | BigInt(lo);
}

// Erase [addr, addr+count) of flash (addr = XIP address or flash offset, both
// accepted), in chunks so each EXEC's ack stays well inside its timeout and
// the progress callback gets 0..1 as it goes. 4 KB granularity like the
// bootrom's ERASE; 64 KB-aligned spans get the block speedup.
export async function blockErase(pb, addr, count, progress = () => {}, chunk = 256 * 1024) {
  await load(pb, 'erase', ERASE_HEX);
  const off = addr & 0x0fffffff;          // strip the XIP base if present
  for (let o = 0; o < count; o += chunk) {
    const n = Math.min(chunk, count - o);
    await pb.write(PARAM_ADDR, u32s(off + o, n));
    await pb.write(RESULT_ADDR, new Uint8Array(4));
    await pb.exec(STUB_ADDR, 60000);
    const dv = await pb.read(RESULT_ADDR, 4);
    if (dv.getUint32(0, true) !== ERASE_MARKER) throw new Error('the erase stub did not report back');
    progress((o + n) / count);
  }
}

// 1024 entries, one lap per second: a sin^2 breath with a gamma so the dark
// end lingers, red at LED_PEAK and green scaled by LED_GREEN for amber (the
// LED has no diffuser: two dies, judged by eye — first cut 1.0 / 0.45 was
// too bright and too green for Eivind). Levels are 0..1023 against the
// PWM's TOP, packed {green << 16 | red} as PWM slice 6's CC register takes them.
const LED_PEAK = 0.4;      // red at the top of the breath, of full scale
const LED_GREEN = 0.14;    // green as a fraction of red
export async function ledPulse(pb) {
  const tbl = new Uint8Array(4096);
  const dv = new DataView(tbl.buffer);
  for (let i = 0; i < 1024; i++) {
    const breath = Math.pow(Math.sin(Math.PI * i / 1024), 2);
    const b = Math.pow(breath, 2.2);
    const r = Math.round(1023 * LED_PEAK * b), g = Math.round(1023 * LED_PEAK * b * LED_GREEN);
    dv.setUint32(4 * i, (g << 16) | r, true);
  }
  await pb.write(LED_TABLE_ADDR, tbl);
  await load(pb, 'led', LED_HEX);
  await pb.write(PARAM_ADDR, u32s(LED_TABLE_ADDR));
  await pb.write(RESULT_ADDR, new Uint8Array(4));
  await pb.exec(STUB_ADDR);
  const r = await pb.read(RESULT_ADDR, 4);
  if (r.getUint32(0, true) !== LED_MARKER) throw new Error('the LED stub did not report back');
}
