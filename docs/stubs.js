// EXEC stubs the flasher runs on the board over PICOBOOT (BOOTSEL), beside
// the board-revision one in boardrev.js. Sources + build: stub/ (make
// prints the hex). Both expect the flash in the serial command state the
// connect-time EXIT_XIP leaves (and leave it that way).
//
//   hashPersona  — the push hash the FPGA accumulates over a persona's
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
// Upper-half flash (stub/flash4_stub.c): the W25Q256's second 16 MB through
// 4-byte-address opcodes, which the bootrom never sends. Every EXEC ends by
// resetting the flash's Extended Address Register and reports it.
const FLASH4_HEX = 'f0b5ce46474600231825142480b595b0099306930d930e9305932b882088bc4980b298472b880b902088ba4980b298472b880c902088b84980b298470b9b0f9098470c9b9847b54bb54a1b681e00b54b1b680193b44b1b680293b44b186803923200012e00d03de2019a029b1343a3401a00531e9a410492049b002b05d1029b002b00d062e1002304930c2312930023a74810aa93810168a64a02251140802292000a43026008271a00a3490398006828420cd0062a0ad81c000e34944206d90024062a01d012aca45c0c600132384203d0062b01d808680133062ae6d9062be4d9c02392499b000a68934c13430b600a68904b1a4080239b0013430b6000231a0003990d6802210d420cd0012a0ad819000e31914206d950425041c821404201402160013208210d4207d0012b05d82168002b01d0c9b209910133012ae0d9012bded9c023002479499b000a6813430b60099ba34200d1c7e00a68754b02201a4080239b0013430627012225000b602300083403990968014204d0002d01d16d4d2f601500214204d0002b02d16a4b1b681300002dedd0002bebd0c02364489b00026811a913430360c5230b800268604b02261a4080239b0013430360002308271a005c48039c2468344208d0012a06d81d000e35954202d98d5c013205603c4203d0012b01d804680133012aead9012be8d9c0224e4992000b6813430b608021c9044a484b4a03684b4d1340802292001343036000231a00022403980068060020420cd0012a0ad818000e30904206d954425441052064422040286001320824264207d0012b05d82868002b01d0c0b20d900133012adfd9012bddd9c022334892000368134303600d9bdb0702d501390029c6d12e492e4b0a6802261a4080239b0013430b6000231a002a4c03990d6835420cd0012a0ad819000e31914206d950425041c821404201402160013208210d4207d0012b05d82168002b01d0c9b20e910133012ae1d9012bdfd9c023174a9b0011680e9c0b431360002c04d0049b002b01d1033304930f9b98470b9b98470c9b9847049a104b1a60104b114a1c60114b1a6015b0c0bcb946b046f0bd494600004558000046430000000200202800001804020020080200200c0200200c800140fffcffff60000018040300200803002046344231000300206b46049a9b889446002b06d18020130002994002814253419c46c749c74a0b68082013408022920013430b6000231f001900ff3aff3a039b1b68134205d0002902d10624be490c603100034204d0002f02d13700ba4b1b680029ecd0002fead0c023b5499b000a68134362460b602123002a00d0bb3312aa1370019bae4c1b0e5370019bad481b0c9370019b1b0ad370019b1371002353712168014080208000014321601900a6480225039c24682c4208d0042906d81d000e358d4202d9555c0131056008252c4203d0042b01d8046801330429e8d9042be6d9c022964992000b6813430b608021c9049348934a0368934d1340802292001343036000231a00022403980068049020420cd0012a0ad818000e30904206d9544254410520644220402860013208240498204207d0012b05d82868002b01d0c0b205900133012aded9012bdcd9c0227b4892000368134303600123059a05981a40184212d001390029c2d17b0004936346002b0cd08023019a5b02d318019380235b02029ad31a0293d3e51700ede78023019a5b01d318019380235b01f1e70590022e00d0d3e0029b002b00d1c8e56b4680221b795200d31a029a9c46934200d994465e495f4b0a6808201a4080239b0013430b600023022219000493039b1b68134205d0002902d1062456490c600121034206d0049b002b03d1524b1b68012304930029ead0049b002be7d0c0234b4c9b00226812a91343236012230b70019b62461b0e4b70019b25001b0c8b70019b501d1b0acb70019b424a0b7100234b71246814408022920022432a601a003d4d0227039c246807943c420ad0904208d91c000e34944204d9042a63d88c5c2c6001320827079c3c4203d0984201d92c6801339042e4d89842e2d8c0222c4992000b6813430b608021c9042848294a0368294d1340802292001343036000231a00022403980068070020420cd0012a0ad818000e30904206d954425441052064422040286001320824274207d0012b05d82868002b01d0c0b206900133012adfd9012bddd9c022114892000368134301220360069b0698134010421ed001390029c3d16346019ad31862460193059b63440593029b9b1a0293049b002b00d13ae7330006e5059ca418053c247897e70c800140fffcffff600000180493e1e7032e48d112ab09321a70019a7f4c120e5a70019a0299120c9a70019a7c4d120ada70019a06311a7100225a712268794b1a4080239b001343236000231a00914208d8994206d8c02370499b000a6813430b60cee40227039c24683c420cd091420ad91f000e37ba4206d20027052a01d812afbf5c2f60013208273c42dfd09942ddd92f68002804d0052b02d9c418063c27700133d3e7042e00d0aae41b681b021b0a08935c4b1b681e005c4b1b681f005b4b1b689bb20693029b002b07d1594b069a1e60584b1f60584b1a6091e48022029b52010493934200d904920c2312aa1370019b494c1b0e5370019b1b0c9370019b1b0ad370019b137100235371049a2068911d434a104080229200024322601a003f480225039c24682c420cd091420ad91d000e35954206d90025052a01d812adad5c0560013208252c4207d0994205d90568052b01d9394c1d5501339142e0d88b42ded3c0232c499b000a6813430b60049b5b080a93089b05930a9b0793304b079a002a0fd1089a0a9b944663441b021b0a019a0893049bd3180193049a029b9b1a02938fe7059a069915046a46948a80225202141b521a07998a4200d90a00a446944200d99446059a3400120c90461d4a9146069a551962461600188802334019002149414144fa0f64007f41144344404f404d44013ef0d16146059a260062441202120a0592069a624492b20692079a521a0792b3e7c0460c80014060000018fffcffff1002002014020020180200200c0300201003002014030020fa7f00200080002001000100';
const FLASH4_MARKER = 0x31423446;          // "F4B1"
export const FLASH4_BUF = 0x20010000;      // SRAM staging for program / read (clear of the LED table and the hash window)
const FLASH4_CHUNK = 32 * 1024;
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

// ---- upper 16 MB of the flash (flash4 stub) ---------------------------------
// Offsets are flash offsets (>= 0x1000000 for the upper half; any works).
const F4_STATUS = ['ok', 'misaligned erase', 'flash busy timeout', 'extended address register stuck'];
async function flash4(pb, params, timeoutMs) {
  await load(pb, 'flash4', FLASH4_HEX);
  await pb.write(PARAM_ADDR, u32s(...params));
  await pb.write(RESULT_ADDR, new Uint8Array(24));
  await pb.exec(STUB_ADDR, timeoutMs);
  const dv = await pb.read(RESULT_ADDR, 24);
  if (dv.getUint32(0, true) !== FLASH4_MARKER) throw new Error('the upper-flash stub did not report back');
  const st = dv.getUint32(4, true);
  if (st) throw new Error('upper flash: ' + (F4_STATUS[st] ?? `status ${st}`));
  return dv;
}
// Run on connect: leaves the flash's extended address register at 0 even if
// an earlier session was cut off inside a 4-byte-address command.
export async function flash4Reset(pb) { await flash4(pb, [0, 0, 0, 0], 5000); }

export async function flash4Erase(pb, off, count, progress = () => {}, chunk = 256 * 1024) {
  for (let o = 0; o < count; o += chunk) {
    const n = Math.min(chunk, count - o);
    await flash4(pb, [1, off + o, n, 0], 60000);
    progress((o + n) / count);
  }
}
export async function flash4Write(pb, off, data, progress = () => {}) {
  for (let o = 0; o < data.length; o += FLASH4_CHUNK) {
    const part = data.subarray(o, Math.min(o + FLASH4_CHUNK, data.length));
    await pb.write(FLASH4_BUF, part);
    await flash4(pb, [2, off + o, part.length, FLASH4_BUF], 30000);
    progress((o + part.length) / data.length);
  }
}
export async function flash4Read(pb, off, n, progress = () => {}) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += FLASH4_CHUNK) {
    const k = Math.min(FLASH4_CHUNK, n - o);
    await flash4(pb, [3, off + o, k, FLASH4_BUF], 30000);
    const dv = await pb.read(FLASH4_BUF, k);
    out.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), o);
    progress((o + k) / n);
  }
  return out;
}
// The push hash (same value as hashPersona / pushHash) over images that may
// sit in the upper half: [{ flashOff, bytes, hwAddr }].
export async function flash4Hash(pb, images, progress = () => {}) {
  const total = images.reduce((a, im) => a + im.bytes, 0);
  let lo = 0, hi = 0, seq = 0, done = 0;
  for (const im of images) {
    for (let o = 0; o < im.bytes; o += HASH_PIECE) {
      const n = Math.min(HASH_PIECE, im.bytes - o);
      const dv = await flash4(pb, [4, im.flashOff + o, n, (im.hwAddr + (o >> 1)) & 0xffffff, lo, hi, seq], 30000);
      lo = dv.getUint32(12, true); hi = dv.getUint32(16, true); seq = dv.getUint32(20, true);
      done += n;
      progress(done / total);
    }
  }
  return (BigInt(hi) << 32n) | BigInt(lo);
}
