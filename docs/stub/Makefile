# Builds the flasher's EXEC stubs and prints the hex to paste into the
# JavaScript (jedec -> ../boardrev.js, hash/erase -> ../stubs.js). Needs an
# arm-none-eabi toolchain on PATH (xpack GCC 14 was used). `make check`
# proves each .o has no unresolved references (a libgcc helper call would
# objcopy into garbage) and runs the hash core on the host against the
# python reference.
CC = arm-none-eabi-gcc
CFLAGS = -mcpu=cortex-m0plus -mthumb -Os -ffreestanding -nostdlib -fno-builtin -fomit-frame-pointer
STUBS = jedec_stub hash_stub erase_stub led_stub
all: $(STUBS:=.bin)
	@for s in $(STUBS); do echo "$$s: $$(xxd -p $$s.bin | tr -d '\n')"; done
%.o: %.c rl_stub.h
	$(CC) $(CFLAGS) -c $< -o $@
%.bin: %.o
	@if arm-none-eabi-objdump -r $< | grep -q 'R_ARM'; then echo "$<: unresolved relocations"; arm-none-eabi-objdump -r $<; exit 1; fi
	arm-none-eabi-objcopy -O binary -j .text $< $@
check: all
	cc -O2 -DHOST_TEST -o hash_host hash_host_test.c && ./hash_host
clean:
	rm -f *.o *.bin hash_host
