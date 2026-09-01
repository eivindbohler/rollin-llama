// BOOTSEL LED stub: makes the RGB LED pulse without any running code.
//
// The LED is common-anode on GP27 (B) / GP28 (R) / GP29 (G), lit when the
// cathode is LOW; the firmware drives it with PWM, inverted polarity
// (hal_pico.c). In BOOTSEL only the bootrom runs, so this stub configures
// hardware that keeps going after it returns: PWM slice 6 (GP28 = 6A,
// GP29 = 6B) at ~1 kHz, its CC register fed by DMA channel 10 from a
// 1024-entry table of {green << 16 | red} levels that the flasher wrote to
// SRAM, paced by DMA timer 0 at clk_sys / 46875 = 1024 Hz (one lap per
// second), read address wrapped on the 4 KB table; channel 11 is a dummy
// one-word transfer the two chain through so the lap repeats for ever.
// Blue is parked HIGH (off) as a plain output. The bootrom uses neither
// PWM nor DMA; the next reboot's firmware resets both.
//
// PARAM: [0] table address (4 KB aligned, 1024 x u32). RESULT: [0] "LED1".
#include "rl_stub.h"
#define MARKER 0x3144454cu
#define IO_CTRL(n)   (*(volatile unsigned *)(0x40014004u + 8u * (n)))
#define SIO_OUT_SET  (*(volatile unsigned *)0xd0000014u)
#define SIO_OE_SET   (*(volatile unsigned *)0xd0000024u)
#define PWM6(off)    (*(volatile unsigned *)(0x40050000u + 6u * 0x14u + (off)))
#define DMA_CH(n, off) (*(volatile unsigned *)(0x50000000u + (n) * 0x40u + (off)))
#define DMA_TIMER0   (*(volatile unsigned *)0x50000420u)
#define CTRL_EN 1u
#define CTRL_SIZE32 (2u << 2)
#define CTRL_INCR_READ (1u << 4)
#define CTRL_RING(bits) ((bits) << 6)         // on the read side (RING_SEL = 0)
#define CTRL_CHAIN(ch) ((ch) << 11)
#define CTRL_TREQ(n) ((n) << 15)
#define CTRL_QUIET (1u << 21)
#define TREQ_TIMER0 0x3bu
#define TREQ_PERMANENT 0x3fu

#define RESETS_RESET_CLR (*(volatile unsigned *)0x4000f000u)   // atomic clear alias
#define RESETS_DONE      (*(volatile unsigned *)0x4000c008u)
#define RST_DMA (1u << 2)
#define RST_IO_BANK0 (1u << 5)
#define RST_PADS_BANK0 (1u << 8)
#define RST_PWM (1u << 14)

__attribute__((noinline)) void led_stub(void)
{
    unsigned table = RL_PARAM[0];
    // The bootrom only takes the blocks it needs out of reset (USB, QSPI
    // pads, PLLs); DMA, PWM and the GPIO bank are still held — registers
    // ignore writes until released.
    unsigned need = RST_DMA | RST_IO_BANK0 | RST_PADS_BANK0 | RST_PWM;
    RESETS_RESET_CLR = need;
    while ((RESETS_DONE & need) != need) ;
    // blue off: SIO output, high
    SIO_OUT_SET = 1u << 27; SIO_OE_SET = 1u << 27; IO_CTRL(27) = 5u;
    // red/green: PWM slice 6, inverted outputs so level = brightness
    PWM6(0x00) = 0;                                   // CSR: off while configuring
    PWM6(0x10) = 1023;                                // TOP
    PWM6(0x04) = 46u << 4;                            // DIV 46.0: 48 MHz / 46 / 1024 = 1.02 kHz
    PWM6(0x0C) = 0;                                   // CC: dark
    PWM6(0x08) = 0;                                   // CTR
    PWM6(0x00) = CTRL_EN | (1u << 2) | (1u << 3);     // EN, A_INV, B_INV
    IO_CTRL(28) = 4u; IO_CTRL(29) = 4u;               // FUNCSEL = PWM
    // DMA timer 0: 1 / 46875 of clk_sys = 1024 Hz at the bootrom's 48 MHz
    DMA_TIMER0 = (1u << 16) | 46875u;
    // channel 11: one dummy word, chains to 10 (restarts the lap)
    DMA_CH(11, 0x00) = table; DMA_CH(11, 0x04) = table + 4092; DMA_CH(11, 0x08) = 1;
    DMA_CH(11, 0x10) = CTRL_EN | CTRL_SIZE32 | CTRL_CHAIN(10) | CTRL_TREQ(TREQ_PERMANENT) | CTRL_QUIET;   // AL1_CTRL (no trigger)
    // channel 10: 1024 words table -> PWM6 CC, read ring 4 KB, paced, chains to 11
    DMA_CH(10, 0x00) = table; DMA_CH(10, 0x04) = 0x40050000u + 6u * 0x14u + 0x0Cu; DMA_CH(10, 0x08) = 1024;
    DMA_CH(10, 0x0C) = CTRL_EN | CTRL_SIZE32 | CTRL_INCR_READ | CTRL_RING(12) | CTRL_CHAIN(11) | CTRL_TREQ(TREQ_TIMER0) | CTRL_QUIET;  // CTRL_TRIG
    RL_RESULT[0] = MARKER;
}
