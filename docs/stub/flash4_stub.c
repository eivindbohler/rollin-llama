// Upper-half flash stub (BOOTSEL / PICOBOOT EXEC) for the W25Q256's second
// 16 MB, which nothing in the bootrom can reach: its READ/WRITE/ERASE and
// XIP send a command + THREE address bytes. This stub drives the SSI itself
// with the dedicated 4-byte-address opcodes, which work in the 3-byte address mode the part
// stays in: 21h 4 KB sector erase, DCh 64 KB block erase, 12h page program,
// 0Ch fast read (8 dummy clocks; fine at any SSI clock). Never B7h (enter
// 4-byte mode), never the non-volatile ADP bit.
//
// THE EAR TRAP: every 4-byte-address command also loads the Extended Address
// Register with A31-A24, and 3-byte reads (XIP, the bootrom's READ, the hash
// stub) then land in the upper half. So EVERY call ends by resetting it — a
// 0Ch read of address 0 (EAR := 0), then C8h to read it back, and 06h + C5h 00
// if that did not take — and reports the final value. An unplug can never
// leave it set: the last thing each EXEC does is clear it. Op 0 does only
// that, for the flasher to run on connect.
//
//   PARAM:  [0] op (0 EAR reset, 1 erase, 2 program, 3 read, 4 hash)
//           [1] flash offset (32-bit), [2] byte count, [3] SRAM buffer (2, 3)
//           op 4: [3] hw_addr, [4] h low, [5] h high, [6] seq (as hash_stub)
//   RESULT: [0] marker "F4B1", [1] status (0 ok, 1 bad alignment, 2 busy
//           timeout, 3 EAR stuck), [2] EAR at exit, op 4: [3] h low,
//           [4] h high, [5] seq
//
// The SSI is in the serial command state the flasher's EXIT_XIP leaves (as
// jedec_stub expects); connect + exit_xip here again for good measure, and
// the stub leaves that state behind. CS is forced through IO_QSPI SS_CTRL,
// bytes go through the 8-bit TX/RX FIFO with at most 14 in flight, like the
// SDK's flash_do_cmd. Position-independent, no globals, no .rodata: every
// command header is built on the stack from immediates.
#include "rl_stub.h"
#include "hash_core.h"
#define MARKER 0x31423446u                                   // "F4B1"
#define SSI_SR       (*(volatile unsigned *)0x18000028u)
#define SSI_DR0      (*(volatile unsigned *)0x18000060u)
#define QSPI_SS_CTRL (*(volatile unsigned *)0x4001800Cu)    // IO_QSPI GPIO_QSPI_SS_CTRL

static inline __attribute__((always_inline)) void cs(unsigned high)
{
    QSPI_SS_CTRL = (QSPI_SS_CTRL & ~0x300u) | (high ? 0x300u : 0x200u);
}
// One CS-low transaction: send h[0..hn), then d[0..dn), then rn zero bytes,
// capturing the bytes clocked in during the zero phase into r (r may be 0).
static inline __attribute__((always_inline))
void spi(const unsigned char *h, unsigned hn, const unsigned char *d, unsigned dn,
         unsigned char *r, unsigned rn)
{
    unsigned total = hn + dn + rn, tx = 0, rx = 0;
    cs(0);
    while (tx < total || rx < total) {
        unsigned f = SSI_SR;
        if ((f & 2u) && tx < total && rx + 14u > tx) {      // TFNF, <= 14 in flight
            SSI_DR0 = tx < hn ? h[tx] : tx < hn + dn ? d[tx - hn] : 0u;
            tx++;
        }
        if ((f & 8u) && rx < total) {                        // RFNE
            unsigned b = SSI_DR0 & 0xFFu;
            if (r && rx >= hn + dn) r[rx - hn - dn] = (unsigned char)b;
            rx++;
        }
    }
    cs(1);
}
static inline __attribute__((always_inline)) void cmd1(unsigned c)
{
    unsigned char h[1]; h[0] = (unsigned char)c;
    spi(h, 1, 0, 0, 0, 0);
}
static inline __attribute__((always_inline)) unsigned rd1(unsigned c)
{
    unsigned char h[1], r[1]; h[0] = (unsigned char)c;
    spi(h, 1, 0, 0, r, 1);
    return r[0];
}
static inline __attribute__((always_inline)) void hdr4(unsigned char *h, unsigned c, unsigned a)
{
    h[0] = (unsigned char)c;
    h[1] = (unsigned char)(a >> 24); h[2] = (unsigned char)(a >> 16);
    h[3] = (unsigned char)(a >> 8);  h[4] = (unsigned char)a;
    h[5] = 0;                                                // 0Ch's dummy byte
}
// 05h until WIP clears; 0 = done, 1 = gave up (~tens of seconds at 48 MHz)
static inline __attribute__((always_inline)) unsigned wait_idle(void)
{
    for (unsigned n = 0; n < 0x4000000u; n++)
        if (!(rd1(0x05u) & 1u)) return 0;
    return 1;
}
// 0Ch fast read of n bytes at a into dst
static inline __attribute__((always_inline)) void read4(unsigned a, unsigned char *dst, unsigned n)
{
    unsigned char h[6]; hdr4(h, 0x0Cu, a);
    spi(h, 6, 0, 0, dst, n);
}

// no-jump-tables: the op dispatch would otherwise call libgcc's
// __gnu_thumb1_case_uhi, which objcopy cannot carry into the stub
__attribute__((noinline, optimize("no-jump-tables"))) void flash4_stub(void)
{
    rl_vfn connect  = rl_rom_fn(RL_CODE('I', 'F'));
    rl_vfn exit_xip = rl_rom_fn(RL_CODE('E', 'X'));
    rl_vfn flush    = rl_rom_fn(RL_CODE('F', 'C'));
    connect(); exit_xip();

    unsigned op = RL_PARAM[0], a = RL_PARAM[1], n = RL_PARAM[2];
    unsigned char *buf = (unsigned char *)RL_PARAM[3];
    unsigned st = 0;
    unsigned char h[6];

    if (op == 1) {                                           // erase, 4 KB-aligned
        if ((a | n) & 0xFFFu) st = 1;
        while (!st && n) {
            unsigned big = !(a & 0xFFFFu) && n >= 0x10000u;
            cmd1(0x06u);                                     // write enable
            hdr4(h, big ? 0xDCu : 0x21u, a);
            spi(h, 5, 0, 0, 0, 0);
            st = wait_idle() ? 2 : 0;
            a += big ? 0x10000u : 0x1000u; n -= big ? 0x10000u : 0x1000u;
        }
    } else if (op == 2) {                                    // program, page by page
        while (!st && n) {
            unsigned k = 0x100u - (a & 0xFFu);
            if (k > n) k = n;
            cmd1(0x06u);
            hdr4(h, 0x12u, a);
            spi(h, 5, buf, k, 0, 0);
            st = wait_idle() ? 2 : 0;
            a += k; buf += k; n -= k;
        }
    } else if (op == 3) {                                    // read into SRAM
        read4(a, buf, n);
    } else if (op == 4) {                                    // push hash of a range
        // read through a fixed 4 KB SRAM window of the stub's own (PARAM[3]
        // carries hw_addr here, not a buffer), well past the stub itself
        unsigned char *win = (unsigned char *)0x20008000u;
        unsigned hw = RL_PARAM[3] & 0xFFFFFFu, lo = RL_PARAM[4], hi = RL_PARAM[5];
        unsigned seq = RL_PARAM[6] & 0xFFFFu;
        while (n) {
            unsigned k = n < 0x1000u ? n : 0x1000u;
            read4(a, win, k);
            hash_image((const volatile unsigned *)win, k / 2, hw, &lo, &hi, &seq);
            hw = (hw + k / 2) & 0xFFFFFFu; a += k; n -= k;
        }
        RL_RESULT[3] = lo; RL_RESULT[4] = hi; RL_RESULT[5] = seq;
    }

    // EAR back to 0, verified, whatever happened above
    hdr4(h, 0x0Cu, 0u);
    { unsigned char r[1]; spi(h, 6, 0, 0, r, 1); }
    unsigned ear = rd1(0xC8u);
    if (ear) {
        cmd1(0x06u);
        { unsigned char w[2]; w[0] = 0xC5u; w[1] = 0u; spi(w, 2, 0, 0, 0, 0); }
        wait_idle();
        ear = rd1(0xC8u);
    }
    if (ear && !st) st = 3;
    flush();
    connect(); exit_xip();
    RL_RESULT[1] = st; RL_RESULT[2] = ear; RL_RESULT[0] = MARKER;
}
