// Shared by the flasher's EXEC stubs: bootrom function lookup (RP2040 table
// at 0x14, lookup routine at 0x18 — pico/bootrom.h), register addresses,
// and the parameter/result slots the JavaScript side fills and reads.
// Position-independent, no globals, no library calls: each stub is ONE
// function, first in its .text, objcopy'd straight out of the .o.
#ifndef RL_STUB_H
#define RL_STUB_H
typedef void *(*rl_lookup_fn)(unsigned short *table, unsigned code);
typedef void  (*rl_vfn)(void);
typedef void  (*rl_erase_fn)(unsigned addr, unsigned count, unsigned block_size, unsigned char block_cmd);
#define RL_CODE(a, b)   ((unsigned)(a) | ((unsigned)(b) << 8))
static inline __attribute__((always_inline)) void *rl_rom_fn(unsigned code)
{
    rl_lookup_fn lookup = (rl_lookup_fn)(unsigned)*(volatile unsigned short *)0x18u;
    unsigned short *table = (unsigned short *)(unsigned)*(volatile unsigned short *)0x14u;
    return lookup(table, code);
}
#define SSI_SSIENR   (*(volatile unsigned *)0x18000008u)
#define SSI_BAUDR    (*(volatile unsigned *)0x18000014u)
#define XIP_BASE     0x10000000u
#define RL_PARAM     ((volatile unsigned *)0x20000200u)   // written by the flasher before EXEC
#define RL_RESULT    ((volatile unsigned *)0x20000300u)   // read by the flasher after the ack
#endif
