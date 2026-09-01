// Host check of hash_stub's 32-bit-halves arithmetic against the reference
// formula (fw_tests.c push_hash_ref_seq / rl_mkflash.py push_hash), on a
// pseudo-random 1 MB buffer split into three images. Build: make check.
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static uint8_t buf[1 << 20];
static uint32_t PARAMV[16], RESULTV[4];
#define RL_PARAM  PARAMV
#define RL_RESULT RESULTV
#define XIP_BASE  ((uintptr_t)buf)
#include "hash_core.h"
// the flasher's chunking: pieces of 128 KB (and an odd 6 KB one) with the
// state threaded through, exactly as stubs.js drives the stub
static void hash_all(uint32_t *P, uint32_t *R)
{
    unsigned lo = 0, hi = 0, seq = 0;
    for (unsigned i = 0; i < P[0]; i++) {
        uint32_t off = P[1 + 3 * i], len = P[2 + 3 * i], hw = P[3 + 3 * i];
        for (uint32_t o = 0; o < len;) {
            uint32_t n = (o == 0 && len > 6144) ? 6144 : (len - o < 131072 ? len - o : 131072);
            hash_image((const volatile unsigned *)(XIP_BASE + off + o), n / 2, (hw + o / 2) & 0xFFFFFF, &lo, &hi, &seq);
            o += n;
        }
    }
    R[0] = lo; R[1] = hi; R[2] = 0x31485348u;
}
#define MARKER 0x31485348u
static uint64_t ref(uint64_t h, uint32_t *seqp, uint32_t hw, const uint8_t *b, uint32_t n)
{
    uint32_t seq = *seqp;
    for (uint32_t off = 0; off < n; off += 1024) {
        uint32_t addr = (hw + off / 2) & 0xFFFFFF, len = n - off < 1024 ? n - off : 1024;
        for (uint32_t j = 0; j + 1 < len; j += 2) {
            uint64_t v = (((uint64_t)addr << 16) | ((uint64_t)b[off + j + 1] << 8) | b[off + j]) + seq;
            h = ((h << 1) | (h >> 63)) ^ v;
            addr = (addr + 1) & 0xFFFFFF; seq = (seq + 1) & 0xFFFF;
        }
    }
    *seqp = seq; return h;
}
int main(void)
{
    uint32_t lcg = 0x12345678u;
    for (size_t i = 0; i < sizeof buf; i++) { lcg = lcg * 1664525u + 1013904223u; buf[i] = lcg >> 24; }
    // three images: 600 KB @hw 0, 256 KB @hw 0x280000 (mk1-like), 32 KB @hw 0xFFF000 (24-bit wrap)
    uint32_t img[3][3] = { {0, 614400, 0}, {614400, 262144, 0x280000}, {876544, 32768, 0xFFF000} };
    PARAMV[0] = 3;
    for (int i = 0; i < 3; i++) for (int k = 0; k < 3; k++) PARAMV[1 + 3 * i + k] = img[i][k];
    hash_all(PARAMV, RESULTV);
    uint64_t got = ((uint64_t)RESULTV[1] << 32) | RESULTV[0], want = 0; uint32_t seq = 0;
    for (int i = 0; i < 3; i++) want = ref(want, &seq, img[i][2], buf + img[i][0], img[i][1]);
    printf("hash stub core: got %016llx want %016llx -> %s\n", (unsigned long long)got, (unsigned long long)want, got == want && RESULTV[2] == MARKER ? "OK" : "MISMATCH");
    return got != want;
}
