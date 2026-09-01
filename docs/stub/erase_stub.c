// Block-erase stub (BOOTSEL / PICOBOOT EXEC): the bootrom's ERASE command
// erases 4 KB sectors only (measured 45 ms each, 0.7 s per 64 KB); the ROM's
// flash_range_erase with the 64 KB block command (D8h) does a block in
// ~150 ms typical. Unaligned ends fall back to sector erases inside the ROM
// routine. PARAM: [0] flash offset, [1] byte count. RESULT: [0] marker "ERS1".
// Leaves the flash in the serial command state, as the bootrom's own ERASE does.
#include "rl_stub.h"
#define MARKER 0x31535245u   // "ERS1"

__attribute__((noinline)) void erase_stub(void)
{
    rl_vfn      connect  = rl_rom_fn(RL_CODE('I', 'F'));
    rl_vfn      exit_xip = rl_rom_fn(RL_CODE('E', 'X'));
    rl_erase_fn erase    = rl_rom_fn(RL_CODE('R', 'E'));
    connect(); exit_xip();
    erase(RL_PARAM[0], RL_PARAM[1], 1u << 16, 0xD8u);
    RL_RESULT[0] = MARKER;
}
