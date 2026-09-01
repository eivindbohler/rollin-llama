// JEDEC-id stub for the web flasher (BOOTSEL / PICOBOOT EXEC).
//
// Runs on the RP2040 from SRAM after the flasher's EXIT_XIP has left the SSI
// in command mode (connect_internal_flash + flash_exit_xip, exactly the
// state the SDK's flash_do_cmd expects). Sends RDID (9Fh) with CS forced
// low, stores the 3 id bytes and a marker at RESULT, restores CS, returns.
// Position-independent, no globals, no calls: build with the Makefile here
// and paste the hex into ../boardrev.js. Same register poking as the SDK's
// flash_do_cmd (hardware/flash.c), nothing from the bootrom.
#define SSI_CTRLR0   (*(volatile unsigned *)0x18000000u)
#define SSI_SR       (*(volatile unsigned *)0x18000028u)
#define SSI_DR0      (*(volatile unsigned *)0x18000060u)
#define QSPI_SS_CTRL (*(volatile unsigned *)0x4001800Cu)   // IO_QSPI GPIO_QSPI_SS_CTRL
#define RESULT       ((volatile unsigned *)0x20000200u)
#define MARKER       0x44494A45u                             // "EJID"

__attribute__((noinline)) void jedec_stub(void)
{
    unsigned tx_rem = 4, rx_rem = 4, id = 0, n = 0;
    QSPI_SS_CTRL = (QSPI_SS_CTRL & ~0x300u) | 0x200u;        // OUTOVER = LOW
    while (tx_rem || rx_rem) {
        unsigned flags = SSI_SR;
        if ((flags & 2u) && tx_rem && (rx_rem - tx_rem) < 14u) {   // TFNF, <= 14 in flight
            SSI_DR0 = (tx_rem == 4) ? 0x9Fu : 0u;
            tx_rem--;
        }
        if ((flags & 8u) && rx_rem) {                        // RFNE
            unsigned b = SSI_DR0 & 0xFFu;
            if (n) id = (id << 8) | b;                       // drop the byte clocked in with the opcode
            n++;
            rx_rem--;
        }
    }
    QSPI_SS_CTRL = (QSPI_SS_CTRL & ~0x300u) | 0x300u;        // OUTOVER = HIGH
    QSPI_SS_CTRL = (QSPI_SS_CTRL & ~0x300u);                 // back to NORMAL
    RESULT[0] = id;
    RESULT[1] = MARKER;
}
