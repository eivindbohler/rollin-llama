// Persona push-hash stub (BOOTSEL / PICOBOOT EXEC): computes, on the board,
// the hash rl_bulk_rx accumulates over a persona's push — the same value
// rl_mkflash.py stores in the RLPH table and the firmware checks at every
// boot — so the flasher can verify a persona's ROM data without reading it
// back over USB (8.85 MB at ~0.5 MB/s = 17 s).
//
// One range per EXEC, with the running state carried in and out so the
// flasher can split a persona into pieces and show progress (an EXEC blocks
// the PICOBOOT link until it returns):
//   PARAM:  [0] flash_off, [1] bytes, [2] hw_addr, [3] h low, [4] h high, [5] seq
//   RESULT: [0] h low, [1] h high, [2] marker "HSH1", [3] seq
// Pieces may be cut anywhere on a halfword: the hash is a stream over
// halfwords with hw_addr advancing with them.
//
// Flash is read through the XIP window. The bootrom's own XIP (serial 03h,
// flash_enter_cmd_xip) measured 1.4 MB/s at the fastest SSI divisor; the
// read side is set up here the way boot_stage2 (boot2_w25q080.S) does it
// instead — quad I/O EBh with continuous read, SCLK = clk_sys/2 = 24 MHz
// in BOOTSEL — after checking the flash's QE bit (programmed if clear, as
// boot2 does). On return connect_internal_flash + flash_exit_xip put the
// flash back in the serial command state the bootrom's READ/WRITE/ERASE
// expect (exit_xip's sequence also ends continuous-read mode).
#include "rl_stub.h"
#include "hash_core.h"
#define MARKER 0x31485348u
#define SSI_CTRLR0      (*(volatile unsigned *)0x18000000u)
#define SSI_CTRLR1      (*(volatile unsigned *)0x18000004u)
#define SSI_SR          (*(volatile unsigned *)0x18000028u)
#define SSI_DR0         (*(volatile unsigned *)0x18000060u)
#define SSI_RX_SAMPLE_DLY (*(volatile unsigned *)0x180000F0u)
#define SSI_SPI_CTRLR0  (*(volatile unsigned *)0x180000F4u)
#define PADS_QSPI       ((volatile unsigned *)0x40020000u)   // [1] SCLK, [2..5] SD0..SD3
#define SR_TFE 0x4u
#define SR_BUSY 0x1u

static inline __attribute__((always_inline)) void wait_ssi_ready(void)
{
    while (!(SSI_SR & SR_TFE) || (SSI_SR & SR_BUSY)) ;
}
// one serial 8-bit command + one data byte, returns the byte clocked in
// with the data byte (SSI in 8-bit TX_AND_RX mode)
static inline __attribute__((always_inline)) unsigned read_flash_sreg(unsigned cmd)
{
    SSI_DR0 = cmd; SSI_DR0 = cmd;            // dummy byte to clock the reply in
    wait_ssi_ready();
    (void)SSI_DR0;
    return SSI_DR0 & 0xFFu;
}

__attribute__((noinline)) void hash_stub(void)
{
    rl_vfn connect  = rl_rom_fn(RL_CODE('I', 'F'));
    rl_vfn exit_xip = rl_rom_fn(RL_CODE('E', 'X'));
    rl_vfn flush    = rl_rom_fn(RL_CODE('F', 'C'));
    connect(); exit_xip(); flush();          // serial command state, CS forcing cleared

    // ---- boot2_w25q080 setup: pads, divisor, QE bit, quad continuous read ----
    PADS_QSPI[1] = (2u << 4) | 1u;           // SCLK: 8 mA drive, fast slew
    unsigned sd = PADS_QSPI[2] & ~2u;        // SD0..3: Schmitt off
    PADS_QSPI[2] = sd; PADS_QSPI[3] = sd; PADS_QSPI[4] = sd; PADS_QSPI[5] = sd;
    SSI_SSIENR = 0;
    SSI_BAUDR = 2;
    SSI_RX_SAMPLE_DLY = 1;
    SSI_CTRLR0 = (7u << 16) | (0u << 8);     // 8-bit frames, TX and RX
    SSI_SSIENR = 1;
    if (read_flash_sreg(0x35u) != 0x02u) {   // QE (status register 2 bit 1)
        SSI_DR0 = 0x06u; wait_ssi_ready(); (void)SSI_DR0;                 // write enable
        SSI_DR0 = 0x01u; SSI_DR0 = 0u; SSI_DR0 = 0x02u; wait_ssi_ready(); // write status: S1 = 0, S2 = QE
        (void)SSI_DR0; (void)SSI_DR0; (void)SSI_DR0;
        while (read_flash_sreg(0x05u) & 1u) ;                             // busy
    }
    SSI_SSIENR = 0;
    SSI_CTRLR0 = (2u << 21) | (31u << 16) | (3u << 8);   // quad, 32-bit frames, EEPROM read
    SSI_CTRLR1 = 0;
    SSI_SPI_CTRLR0 = (8u << 2) | (4u << 11) | (2u << 8) | (1u << 0);   // ADDR_L 8 (32 bits), 4 wait, 8-bit inst, 1C2A
    SSI_SSIENR = 1;
    SSI_DR0 = 0xEBu; SSI_DR0 = 0xA0u;        // one EBh read with mode bits 1010: continuous read from now on
    wait_ssi_ready();
    SSI_SSIENR = 0;
    SSI_SPI_CTRLR0 = (0xA0u << 24) | (8u << 2) | (4u << 11) | (0u << 8) | (2u << 0);   // no inst, mode bits as XIP_CMD, 2C2A
    SSI_SSIENR = 1;

    unsigned lo = RL_PARAM[3], hi = RL_PARAM[4], seq = RL_PARAM[5] & 0xFFFFu;
    hash_image((const volatile unsigned *)(XIP_BASE + RL_PARAM[0]), RL_PARAM[1] / 2,
               RL_PARAM[2] & 0xFFFFFFu, &lo, &hi, &seq);
    connect(); exit_xip();
    RL_RESULT[0] = lo; RL_RESULT[1] = hi; RL_RESULT[2] = MARKER; RL_RESULT[3] = seq;
}
