<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo.svg">
  <img src="docs/logo-black.svg" alt="Rollin' Llama" width="380">
</picture>

# Rollin' Llama

A MIDI wavetable daughterboard (standard 2×13 wavetable-header form factor)
with four selectable synth personas — Roland MT-32, CM-32L, SC-55 mk1 and
SC-55 mk2 — each running the machine's original control firmware on
clean-room HDL models of the original hardware.

- Spartan-7 XC7S50 FPGA + RP2040
- 8 MB SDRAM, 16 MB QSPI flash, PCM5102A DAC
- MIDI in via the wavetable header, DIN jack, or USB-MIDI
- Persona switching by button, SysEx, or the bundled DOS tool (ROLLIN.COM)

Nothing Roland wrote ships with this project: control and PCM ROMs are
supplied by you, from your own units, at flash time — see the web flasher.

## Flashing and updates

Use the **[web flasher](https://eivindbohler.github.io/rollin-llama/)**
(Chrome required — it talks to the board over WebMIDI and WebUSB):

1. Download a firmware release (`.uf2`) from this repo's
   [Releases](../../releases) page.
2. Open the flasher, put the board in BOOTSEL mode, connect.
3. Flash the release, then upload your ROM dumps — they are verified and
   converted entirely in your browser; no ROM data leaves your machine.
4. Optional — the *Settings* card switches the board's extra USB interfaces
   (audio capture stream, USB audio) on; both are off until you enable them. Your computer sees each one
   as its own device, so it may ask for permission once per interface. The
   USB audio input is a 48 kHz stereo source, whichever persona is playing.

The board remembers the persona that was last active and starts there on
the next power-up.

## Releases

Each tagged release is a single `.uf2` containing the RP2040 firmware and
all four FPGA bitstreams. ROM data is never included.
