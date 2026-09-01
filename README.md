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
   [Releases](../../releases) page — the plain file unless you are
   recovering a card, see *Releases* below.
2. Open the flasher, put the board in BOOTSEL mode, connect.
3. Flash the release, then upload your ROM dumps — they are verified and
   converted entirely in your browser; no ROM data leaves your machine.
4. Optional — the *Settings* card switches the board's extra USB interfaces
   (audio capture stream, USB audio) on; both are off until you enable them. Your computer sees each one
   as its own device, so it may ask for permission once per interface. The
   USB audio input is a 48 kHz stereo source, whichever persona is playing.

The board remembers the persona that was last active and starts there on
the next power-up.

### Windows: one-time driver setup

macOS and Linux need nothing. Windows does not attach a driver to the
bootloader's PICOBOOT interface on its own, so the flasher can see the board
but not talk to it until you do this once per computer:

- Install [Zadig](https://zadig.akeo.ie/), run it as administrator, tick
  *Options → List All Devices*, choose **RP2 Boot (Interface 1)** — interface
  1, not 0, which is the drive — pick **WinUSB** and install.
- On ARM versions of Windows, Zadig has no driver package to install and will
  fail. Use Device Manager instead: right-click **RP2 Boot**, *Update driver →
  Browse → Let me pick*, choose *Universal Serial Bus devices*, then **WinUsb
  Device**. That attaches the driver but not the device interface GUID an
  application needs, so also run these two lines in an administrator
  PowerShell:

      $d = Get-PnpDevice | Where-Object { $_.InstanceId -like 'USB\VID_2E8A&PID_0003&MI_01*' }
      New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Enum\$($d.InstanceId)\Device Parameters" -Name DeviceInterfaceGUIDs -PropertyType MultiString -Value '{86DFF346-1BBA-47A0-B5CA-18CBB02BEF80}' -Force

Then replug the board in BOOTSEL mode and connect again. Flashing firmware by
dragging a `.uf2` onto the RPI-RP2 drive works without any of this; only ROM
uploads and settings go through PICOBOOT.

## Releases

Each tagged release carries two `.uf2` files. Both hold the RP2040 firmware
and all four FPGA bitstreams, and neither contains any ROM data.

- `rollin-llama-vX.Y.Z.uf2` is the normal update. Your uploaded ROMs and
  your settings are untouched.
- `rollin-llama-vX.Y.Z-full.uf2` rewrites the whole 16 MB flash, for a card
  in an unknown state. Everything else is erased, so the ROMs have to be
  uploaded again afterwards and the USB interface settings go back to off.
  The file is 33.5 MB and takes a few minutes to flash.

Either can be flashed with the web flasher or by dragging it onto the
RPI-RP2 drive in BOOTSEL mode.
