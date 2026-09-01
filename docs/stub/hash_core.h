// The push-hash core, shared by hash_stub.c (board) and hash_host_test.c
// (host check): h = rotl64(h,1) ^ (((addr << 16) | halfword) + seq) per
// halfword, addr 24-bit, seq 16-bit, both wrapping.
//
// The C version is what the host test runs. On the Cortex-M0+ the same
// loop compiled to ~55 instructions per halfword with stack spills (64-bit
// emulation + 9 live values on 8 low registers: measured 1.4 us per
// halfword at the bootrom's 48 MHz), so the stub uses the inline-assembly
// inner loop below (~14 instructions): a chunk runs with addr[23:16] and
// the seq/addr wraps hoisted out — the outer loop cuts chunks at every
// 64 K-halfword boundary of addr and of seq.
static inline __attribute__((always_inline))
void hash_image(const volatile unsigned *p, unsigned halfwords, unsigned addr,
                unsigned *lo_io, unsigned *hi_io, unsigned *seq_io)
{
    unsigned lo = *lo_io, hi = *hi_io, seq = *seq_io;
    const volatile unsigned short *q = (const volatile unsigned short *)p;
    while (halfwords) {
        unsigned to_addr_wrap = 0x10000u - (addr & 0xFFFFu);
        unsigned to_seq_wrap  = 0x10000u - seq;
        unsigned n = halfwords;
        if (n > to_addr_wrap) n = to_addr_wrap;
        if (n > to_seq_wrap)  n = to_seq_wrap;
        unsigned a_lo = addr << 16, a_hi = (addr >> 16) & 0xFFu;
#if defined(__thumb__) && !defined(HOST_TEST)
        // v_k = ((addr0 + k) << 16 | d_k) + seq0 + k = W + k * 0x10001 + d_k
        // with W = (addr0 << 16) + seq0: one 64-bit running term (W_lo, W_hi)
        // instead of separate addr and seq; inside a chunk neither wraps.
        register unsigned w_hi asm("r8") = a_hi;
        register unsigned inc  asm("r9") = 0x10001u;
        unsigned w_lo = a_lo + seq, cnt = n;
        __asm__ volatile (
            ".syntax unified\n"
            "1:\n"
            "  ldrh  r0, [%[q]]\n"            // d
            "  adds  %[q], #2\n"
            "  adds  r0, %[wlo]\n"            // v_lo = W_lo + d, C = carry
            "  movs  r1, #0\n"                // (MOVS #imm leaves C alone)
            "  adcs  r1, r1\n"                // r1 = carry
            "  add   r1, %[whi]\n"            // v_hi = W_hi + carry
            "  lsrs  r2, %[hi], #31\n"        // rotl64(h, 1):
            "  lsls  %[lo], %[lo], #1\n"      //   C = lo[31]
            "  adcs  %[hi], %[hi]\n"          //   hi = hi << 1 | C
            "  orrs  %[lo], r2\n"             //   lo |= old hi[31]
            "  eors  %[lo], r0\n"             // h ^= v
            "  eors  %[hi], r1\n"
            "  add   %[wlo], %[inc]\n"        // W += 0x10001
            "  subs  %[cnt], #1\n"
            "  bne   1b\n"
            : [q] "+l" (q), [lo] "+l" (lo), [hi] "+l" (hi), [wlo] "+l" (w_lo), [cnt] "+l" (cnt)
            : [whi] "r" (w_hi), [inc] "r" (inc)
            : "r0", "r1", "r2", "cc", "memory");
        addr = (addr + n) & 0xFFFFFFu;
        seq = (seq + n) & 0xFFFFu;
#else
        for (unsigned k = 0; k < n; k++) {
            unsigned long long v = ((unsigned long long)a_hi << 32) | (a_lo | q[k]);
            v += seq;
            unsigned nhi = (hi << 1) | (lo >> 31);
            unsigned nlo = (lo << 1) | (hi >> 31);
            lo = nlo ^ (unsigned)v;
            hi = nhi ^ (unsigned)(v >> 32);
            a_lo += 0x10000u;
            seq++;
        }
        q += n;
        addr = (addr + n) & 0xFFFFFFu;
        seq &= 0xFFFFu;
#endif
        halfwords -= n;
    }
    *lo_io = lo; *hi_io = hi; *seq_io = seq;
}
