// PICOBOOT over WebUSB — a port of picotool's picoboot_connection.c.
//
// Wire protocol (boot/picoboot.h): 32-byte command on the bulk OUT endpoint
//   { dMagic 0x431fd10b, dToken, bCmdId (top bit = IN), bCmdSize,
//     pad16, dTransferLength, args[16] }
// then the data phase (IN for 0x8x commands, OUT otherwise), then an ack in
// the OPPOSITE direction (the reference passes a 1-byte buffer; the device
// completes it as a zero-length packet).
export const FLASH_BASE = 0x10000000;

const MAGIC = 0x431fd10b;
const PC = {
  EXCLUSIVE: 0x01, REBOOT: 0x02, ERASE: 0x03, READ: 0x84,
  WRITE: 0x05, EXIT_XIP: 0x06, EXEC: 0x08,
};
const IF_RESET = 0x41;

export const SECTOR = 4096;
export const PAGE = 256;

// Thrown when the PICOBOOT interface exists but Windows won't hand it over:
// winusb.sys not bound to interface 1, or bound with no DeviceInterfaceGUIDs
// value under the function's Device Parameters key, so there is no device
// interface for Chromium to open. Claiming then either fails outright or
// never settles, depending on which of the two is missing — both land here.
export class ClaimBlockedError extends Error {
  constructor(cause) {
    super('the PICOBOOT interface could not be claimed');
    this.name = 'ClaimBlockedError';
    this.cause = cause;
  }
}

// Every step of the connect handshake gets a deadline. Without one a stalled
// claim leaves the page looking dead, and a second attempt then trips
// Chrome's "operation that changes interface state is in progress" guard
// against the first attempt's still-pending promise.
function deadline(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

export async function openPicoboot(dev) {
  // open() resolves immediately on an already-open device per spec, but a
  // half-finished earlier attempt can leave one open with nothing claimed.
  if (!dev.opened) await deadline(dev.open(), 10000, 'opening the board');
  if (dev.configuration === null)
    await deadline(dev.selectConfiguration(1), 5000, 'configuring the board');

  let ifNum = -1, outEp = -1, inEp = -1;
  for (const intf of dev.configuration.interfaces) {
    for (const alt of intf.alternates) {
      if (alt.interfaceClass !== 0xff) continue;
      const bulks = alt.endpoints.filter(e => e.type === 'bulk');
      if (bulks.length !== 2) continue;
      ifNum = intf.interfaceNumber;
      for (const e of bulks)
        if (e.direction === 'out') outEp = e.endpointNumber;
        else inEp = e.endpointNumber;
    }
  }
  if (ifNum < 0) throw new Error('PICOBOOT interface not found (is this an RP2 in BOOTSEL mode?)');
  try {
    await deadline(dev.claimInterface(ifNum), 5000, 'claiming the interface');
  } catch (e) {
    throw new ClaimBlockedError(e);
  }
  await deadline(ifReset(), 5000, 'resetting the interface');

  let token = 1;

  async function ifReset() {
    await dev.controlTransferOut({
      requestType: 'vendor', recipient: 'interface',
      request: IF_RESET, value: 0, index: ifNum,
    });
  }

  // A yanked cable can leave a pending transfer unresolved forever, so every
  // transfer races a timeout. The ack of an OUT command completes only when
  // the operation finishes, so ERASE gets a long ack budget.
  const XFER_TIMEOUT = 8000;
  function withTimeout(p, ms, what) {
    let t;
    return Promise.race([
      p.finally(() => clearTimeout(t)),
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`${what} timed out — board unplugged?`)), ms);
      }),
    ]);
  }

  // On a rejected command the bootrom stalls the bulk endpoints; clear the
  // halts and reset the interface so the next command isn't doomed too.
  async function recover() {
    try { await dev.clearHalt('out', outEp); } catch (e) { /* best effort */ }
    try { await dev.clearHalt('in', inEp); } catch (e) { /* best effort */ }
    try { await ifReset(); } catch (e) { /* best effort */ }
  }

  // args: Uint8Array (≤16 bytes). Returns the IN-phase DataView for 0x8x
  // commands, else null.
  async function cmd(id, args, transferLength = 0, outData = null, ackTimeout = XFER_TIMEOUT) {
    const b = new ArrayBuffer(32);
    const v = new DataView(b);
    v.setUint32(0, MAGIC, true);
    v.setUint32(4, token++, true);
    v.setUint8(8, id);
    v.setUint8(9, args.length);
    v.setUint32(12, transferLength, true);
    new Uint8Array(b, 16).set(args);

    try {
      let r = await withTimeout(dev.transferOut(outEp, b), XFER_TIMEOUT, 'command');
      if (r.status !== 'ok') throw new Error(`cmd 0x${id.toString(16)}: ${r.status}`);

      let inData = null;
      if (transferLength) {
        if (id & 0x80) {
          const d = await withTimeout(dev.transferIn(inEp, transferLength), XFER_TIMEOUT, 'read');
          if (d.status !== 'ok' || d.data.byteLength !== transferLength)
            throw new Error(`read data phase: ${d.status} (${d.data?.byteLength}/${transferLength})`);
          inData = d.data;
        } else {
          r = await withTimeout(dev.transferOut(outEp, outData), XFER_TIMEOUT, 'write');
          if (r.status !== 'ok') throw new Error(`write data phase: ${r.status}`);
        }
      }
      // ack, opposite direction (mirrors picoboot_connection.c). A stall here
      // means the device REJECTED the command — surface it, don't ignore it.
      if (id & 0x80) {
        const a = await withTimeout(dev.transferOut(outEp, new Uint8Array(1)), XFER_TIMEOUT, 'ack');
        if (a.status !== 'ok')
          throw new Error(`cmd 0x${id.toString(16)} rejected (ack ${a.status})`);
      } else {
        const a = await withTimeout(dev.transferIn(inEp, 1), ackTimeout, 'ack');
        if (a.status !== 'ok')
          throw new Error(`cmd 0x${id.toString(16)} rejected (ack ${a.status})`);
      }
      return inData;
    } catch (e) {
      await recover();
      throw e;
    }
  }

  const u32 = (...ws) => {
    const a = new Uint8Array(ws.length * 4);
    const v = new DataView(a.buffer);
    ws.forEach((w, i) => v.setUint32(i * 4, w, true));
    return a;
  };

  const api = {
    async exclusive(on = 1) { await cmd(PC.EXCLUSIVE, new Uint8Array([on])); },
    async exitXip()         { await cmd(PC.EXIT_XIP, new Uint8Array(0)); },
    async erase(addr, size) { await cmd(PC.ERASE, u32(addr, size), 0, null, 60000); },
    async write(addr, data) { await cmd(PC.WRITE, u32(addr, data.byteLength), data.byteLength, data); },
    async read(addr, size)  { return cmd(PC.READ, u32(addr, size), size); },
    // Call a function the flasher put in SRAM (thumb bit set for the call);
    // the ack comes back when it returns. Used for the board-revision stub.
    async exec(addr, ackTimeoutMs = 10000) { await cmd(PC.EXEC, u32(addr | 1), 0, null, ackTimeoutMs); },
    async reboot(delayMs = 500) {
      // pc=0 sp=0 -> regular boot path; the device drops off USB, so the
      // ack (and even the command status) may never complete — ignore.
      try { await cmd(PC.REBOOT, u32(0, 0, delayMs)); } catch (e) { /* expected */ }
    },
    ifReset,
    device: dev,
    close() { return dev.close().catch(() => {}); },
  };

  await api.exclusive(1);
  await api.exitXip();
  return api;
}

// ---- UF2 ------------------------------------------------------------------
const UF2_MAGIC0 = 0x0a324655, UF2_MAGIC1 = 0x9e5d5157, UF2_MAGIC_END = 0x0ab16f30;
const RP2040_FAMILY = 0xe48bff56;

// Parse a UF2 into sorted, coalesced { addr, data } ranges (page-granular
// content; blank-skipped pages simply don't appear). Throws on malformed
// blocks or a non-RP2040 family.
export function parseUf2(buf) {
  if (buf.byteLength % 512) throw new Error('UF2 size is not a multiple of 512');
  const n = buf.byteLength / 512;
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const v = new DataView(buf, i * 512, 512);
    if (v.getUint32(0, true) !== UF2_MAGIC0 || v.getUint32(4, true) !== UF2_MAGIC1 ||
        v.getUint32(508, true) !== UF2_MAGIC_END)
      throw new Error(`block ${i}: bad magic`);
    const flags = v.getUint32(8, true);
    if ((flags & 0x2000) && v.getUint32(28, true) !== RP2040_FAMILY)
      throw new Error(`block ${i}: not an RP2040 UF2`);
    const addr = v.getUint32(12, true);
    const size = v.getUint32(16, true);
    if (size !== PAGE || addr % PAGE) throw new Error(`block ${i}: bad page`);
    blocks.push({ addr, data: new Uint8Array(buf, i * 512 + 32, PAGE) });
  }
  blocks.sort((a, b) => a.addr - b.addr);
  const ranges = [];
  for (const blk of blocks) {
    const last = ranges[ranges.length - 1];
    if (last && last.addr + last.parts.length * PAGE === blk.addr) {
      last.parts.push(blk.data);
    } else {
      ranges.push({ addr: blk.addr, parts: [blk.data] });
    }
  }
  return ranges.map(r => {
    const data = new Uint8Array(r.parts.length * PAGE);
    r.parts.forEach((p, i) => data.set(p, i * PAGE));
    return { addr: r.addr, data };
  });
}

// Flash a parsed UF2: erase every touched 4K sector once (merged spans, so
// two ranges sharing a sector cannot wipe each other), write page runs,
// read-back verify. `progress(frac, label)` is called throughout.
//
// Erases go out in ERASE_CHUNK pieces: the bootrom acks an ERASE only when
// the flash is done, and a full-chip image merges into ONE 16 MB span —
// ~40 s of block erases on a typical part, well past a per-command ack
// budget on a slow one, with the progress bar parked at 0 % the whole
// time (measured 2026-09-13: 45 ms per 4 KB sector, 185 s for 16 MB — the
// bootrom does plain sector erases). 64 KB per command bounds the wait to
// under a second and gives the bar something to show.
const ERASE_CHUNK = 64 * 1024;           // measured: 45 ms per 4K sector, no block speedup -> 0.7 s per command
// `eraseFn(addr, size, progress)` replaces the bootrom's sector-erase ERASE
// when given (stubs.js blockErase: ~5x) — the phase weights follow.
export async function flashUf2(pb, ranges, progress = () => {}, eraseFn = null) {
  const sectors = new Set();
  for (const r of ranges)
    for (let s = r.addr & ~(SECTOR - 1); s < r.addr + r.data.length; s += SECTOR)
      sectors.add(s);
  const sorted = [...sectors].sort((a, b) => a - b);
  // merge into contiguous erase spans
  const spans = [];
  for (const s of sorted) {
    const last = spans[spans.length - 1];
    if (last && last.addr + last.size === s) last.size += SECTOR;
    else spans.push({ addr: s, size: SECTOR });
  }
  const totalW = ranges.reduce((a, r) => a + r.data.length, 0);
  const totalE = spans.reduce((a, sp) => a + sp.size, 0);
  // phase weights: erase / write / verify, from measured PICOBOOT cost per
  // 4 KB on the card (2026-09-13: erase 45.6 ms, write 14.6 ms, read-back
  // 7.8 ms, i.e. 67 / 21 / 12 %), rounded to whole tens so the phase
  // boundaries land on 70 % and 90 %. Every touched sector is erased,
  // written and read once, so the ratio holds for any image size.
  // (block erase: ~9 ms per 4 KB -> 30 / 45 / 25 %)
  const [E, W, V] = eraseFn ? [0.3, 0.45, 0.25] : [0.7, 0.2, 0.1];
  let done = 0;
  for (const sp of spans) {
    if (eraseFn) {
      const base = done;
      await eraseFn(sp.addr, sp.size, f => progress(E * ((base + f * sp.size) / totalE), 'erasing'));
      done += sp.size;
      continue;
    }
    for (let o = 0; o < sp.size; o += ERASE_CHUNK) {
      const n = Math.min(ERASE_CHUNK, sp.size - o);
      progress(E * (done / totalE), 'erasing');
      await pb.erase(sp.addr + o, n);
      done += n;
    }
  }
  progress(E, 'erasing');
  done = 0;
  const CHUNK = SECTOR;                       // 4K write/verify granularity
  for (const r of ranges) {
    for (let o = 0; o < r.data.length; o += CHUNK) {
      const part = r.data.subarray(o, Math.min(o + CHUNK, r.data.length));
      await pb.write(r.addr + o, part);
      done += part.length;
      progress(E + W * (done / totalW), 'writing');
    }
  }
  done = 0;
  for (const r of ranges) {
    for (let o = 0; o < r.data.length; o += CHUNK) {
      const part = r.data.subarray(o, Math.min(o + CHUNK, r.data.length));
      const dv = await pb.read(r.addr + o, part.length);
      const back = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      for (let i = 0; i < part.length; i++)
        if (back[i] !== part[i])
          throw new Error(`verify failed @0x${(r.addr + o + i).toString(16)}`);
      done += part.length;
      progress(E + W + V * (done / totalW), 'verifying');
    }
  }
  progress(1, 'done');
}
