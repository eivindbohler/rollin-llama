// Board revision over PICOBOOT: the boot flash's JEDEC id (RDID, 9Fh), read
// by a stub the flasher uploads to SRAM and runs with EXEC. The one part
// that differs between board revisions and needs no provisioning:
//   W25Q128JV  EF 40 18  -> rev 1.0 (SDRAM board)
//   W25Q256JV  EF 40 19  -> rev 1.1 (PSRAM board, 32 MB flash)
// An image says which revision it needs in its RLVR block (fmt 2, minimum
// board rev at +0x50, written by rl_mkflash.py --min-hw); flashing a newer
// image onto an older board is refused before anything is written. The
// firmware makes the same check at boot (STATUS_HW_MISMATCH), so drag-drop
// UF2s are covered too.
//
// Stub: stub/jedec_stub.c, built by stub/Makefile (156 bytes, position
// independent, no calls). It expects the SSI in command mode, which is what
// the flasher's EXIT_XIP at connect leaves behind.
export const STUB_ADDR = 0x20000000;      // low SRAM: unused by the bootrom in BOOTSEL
export const RESULT_ADDR = 0x20000200;    // { u32 jedec, u32 marker "EJID" }
const MARKER = 0x44494a45;
const STUB_HEX = '1f4b204a1968f0b51140802292000a4300241a6004222000110002261a4d2d6835420bd0002909d0561a0d2e06d80026042900d19f36154f01393e60082635420bd0002a09d0114d2d68002c03d0b040f736354028430134013a0d001543dcd1c022196892000a431a601a6805490a401a60074b074a1860074b1a60f0bdc0460c800140fffcffff280000186000001800020020454a494404020020';

export const REV_TABLE = {
  0xEF4018: { rev: 0x0100, flash: 'W25Q128', desc: '128 Mbit flash, 64 Mbit SDRAM' },
  0xEF4019: { rev: 0x0101, flash: 'W25Q256', desc: '256 Mbit flash, 2 x 64 Mbit PSRAM' },
};

export function revText(rev) { return `v${rev >> 8}.${rev & 0xff}`; }

// Returns { jedec, rev, flash, desc } — rev 0 and flash/desc null when the id is not in
// the table (no gate applied, as in the firmware). Throws if the stub could
// not be run or did not report back.
export async function readBoardRev(pb) {
  const stub = Uint8Array.from(STUB_HEX.match(/../g), h => parseInt(h, 16));
  const blank = new Uint8Array(8);                       // clear the result slot first
  await pb.exitXip();                                    // SSI in command mode, whatever ran before
  await pb.write(RESULT_ADDR, blank);
  await pb.write(STUB_ADDR, stub);
  await pb.exec(STUB_ADDR);
  const dv = await pb.read(RESULT_ADDR, 8);
  if (dv.getUint32(4, true) !== MARKER) throw new Error('the board-revision stub did not report back');
  const jedec = dv.getUint32(0, true) & 0xffffff;
  const e = REV_TABLE[jedec];
  return { jedec, rev: e ? e.rev : 0, flash: e ? e.flash : null, desc: e ? e.desc : null };
}

// Minimum board revision an RLVR block asks for (fmt >= 2), else 0.
export function minHwFromVerBlk(dv) {
  if (dv.byteLength < 0x52 || dv.getUint32(0, true) !== 0x52564c52) return 0;
  if (dv.getUint32(4, true) < 2) return 0;
  return (dv.getUint8(0x50) << 8) | dv.getUint8(0x51);
}
