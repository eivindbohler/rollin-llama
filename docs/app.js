// Rollin' Llama web flasher — connection state machine.
//
// Normal mode: the board is a USB-MIDI device ("Rollin' Llama"). The live-mode
// operations are the BOOTSEL doorbell SysEx (F0 7D 52 4C 02 F7) and the
// volume SysEx (F0 7D 52 4C 03 vv F7); everything else — version read,
// firmware flash, ROM writes, settings — happens over PICOBOOT (WebUSB) once
// the board re-enumerates as RPI-RP2.
import { REFERENCE_ROMS, PERSONAS, sha1hex } from './roms.js';
import { parseManifest, parsePushTable, pushHash, pushedImages, hasUpper,
         imageExtents, romEraseSpans, MANIFEST_OFF, PUSH_TBL_OFF, FWTAB_TBL_OFF, parseFwTables,
         UPPER_BASE, FW_TABLE_HW } from './manifest.js';
import { filePlan, applyXform, applyXformFwd } from './transforms.js';
import { openPicoboot, parseUf2, flashUf2, ClaimBlockedError,
         FLASH_BASE, SECTOR, PAGE } from './picoboot.js';
import { SETTINGS_OFF, RECORD_LEN, FLAG_USB_VENDOR, FLAG_USB_AUDIO, FLAG_ANALOG_MASK,
         VOLUME_MAX, decodeSettings, encodeSettings } from './settings.js';
import { readBoardRev, minHwFromVerBlk, revText } from './boardrev.js';
import { hashPersona, blockErase, ledPulse, forgetStubs,
         flash4Reset, flash4Erase, flash4Write, flash4Read, flash4Hash } from './stubs.js';
import { buildGs2kPack } from './gs2kpack.js';
import { zipFiles } from './zip.js';

const VER_BLK_OFF = 0x020300;      // RLVR: magic + fmt + ver[32] git[24] date[16] (+ min board rev, fmt 2)
const VER_BLK_LEN = 0x58;
// Firmware self-check trailer: the firmware
// carries magic + image length + CRC-32 and verifies itself at boot (red SOS
// on the LED when it fails). The same CRC-32 (zlib / IEEE) is recomputed
// here over the firmware slot, and over a UF2 before it is flashed.
const FW_SLOT = 0x020000;          // firmware slot, 128 KB from flash offset 0
const FW_MAGIC = 'RLFW-CRC32-TRLR\0';
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (~crc) >>> 0;
}
const hex8 = v => v.toString(16).padStart(8, '0');
// Check a firmware image (the bytes from flash offset 0). Returns
//   { state: 'none' }                       no trailer: firmware predates the check
//   { state: 'ok' | 'corrupt', len, crc, got }
function fwCheck(bytes) {
  const magic = new TextEncoder().encode(FW_MAGIC);
  let off = -1;
  outer: for (let i = 0; i + 24 <= bytes.length; i++) {
    if (bytes[i] !== magic[0]) continue;
    for (let k = 1; k < 16; k++) if (bytes[i + k] !== magic[k]) continue outer;
    off = i; break;
  }
  if (off < 0) return { state: 'none' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const len = dv.getUint32(off + 16, true), crc = dv.getUint32(off + 20, true);
  if (!len || len > bytes.length) return { state: 'corrupt', len, crc, got: 0 };
  let got = crc32(bytes.subarray(0, off + 20));
  got = crc32(new Uint8Array(4), got);
  got = crc32(bytes.subarray(off + 24, len), got);
  return { state: got === crc ? 'ok' : 'corrupt', len, crc, got };
}
// The firmware image inside a parsed UF2 (the range that starts at the
// flash base), or null when the file carries no firmware.
function uf2Firmware(ranges) {
  const r = ranges.find(r => r.addr === FLASH_BASE);
  return r ? r.data.subarray(0, Math.min(r.data.length, FW_SLOT)) : null;
}
// Flash regions a release UF2 never touches: the ROM data and the settings
// sector. A file that writes into either is the full recovery image, which
// wipes the user's ROM uploads and settings.
// ROM data for the "this file erases your ROMs" check: the board's own
// image extents when its manifest has been read, else the v6 map's data
// slots. Image extents, not the span between the first and the last: map v8
// keeps the gs2k bitstream (which every release UF2 writes) between ROM
// images. Uploads, verification and the stubs never use this — they go by
// the manifest records.
const ROM_DATA_OFF_V6 = 0x430000, ROM_DATA_END_V6 = 0xC30000;
function romExtents() {
  const ext = imageExtents(manifest);
  return ext.length ? ext : [[ROM_DATA_OFF_V6, ROM_DATA_END_V6]];
}
const VER_BLK_MAGIC = 0x52564c52;

const RPI_VID = 0x2e8a, RPI_BOOT_PID = 0x0003;
const DOORBELL = [0xF0, 0x7D, 0x52, 0x4C, 0x02, 0xF7];
const VOLUME_SYX = v => [0xF0, 0x7D, 0x52, 0x4C, 0x03, v & 0x7F, 0xF7];
const VOLUME_QUERY = [0xF0, 0x7D, 0x52, 0x4C, 0x04, 0xF7];   // reply: same, + vv before F7
const STAGE_SYX = m => [0xF0, 0x7D, 0x52, 0x4C, 0x05, m & 0x07, 0xF7];   // vintage output stage: bit 0 MT-32 family, bit 1 SC-55 family
const STAGE_QUERY = [0xF0, 0x7D, 0x52, 0x4C, 0x06, 0xF7];   // reply: same, + mode before F7
const MIDI_NAME = "Rollin' Llama";

const $ = id => document.getElementById(id);
const setStatus = (id, msg, cls = '') => {
  const el = $(id); el.textContent = msg; el.className = 'status ' + cls;
};

// ---- capability check -------------------------------------------------------
if (!('usb' in navigator) || !('requestMIDIAccess' in navigator)) {
  $('chrome-warning').classList.remove('hidden');
  $('btn-bootsel').disabled = true;
  $('btn-set-volume').disabled = true;
}

// ---- WebMIDI: the board's output port in normal mode ------------------------
// One access object for the session (the permission prompt happens once);
// null when no "Rollin' Llama" output exists, i.e. the board is unplugged or
// already in BOOTSEL.
let midiAccess = null;
// Status lines for things that normally finish in milliseconds appear only
// when they take longer than this — otherwise they flash by unreadably.
const SLOW_MS = 400;
function slowStatus(id, msg) {
  const t = setTimeout(() => setStatus(id, msg), SLOW_MS);
  return () => clearTimeout(t);
}
async function midiOut(statusId) {
  if (!midiAccess) {
    const done = slowStatus(statusId,
      'Requesting MIDI access — if nothing happens, look for a permission ' +
      'icon at the right end of the address bar.');
    try {
      midiAccess = await Promise.race([
        navigator.requestMIDIAccess({ sysex: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(
          'no response from the permission prompt. Check the address-bar icon, ' +
          'or allow MIDI for this site under chrome://settings/content/midiDevices'
        )), 15000)),
      ]);
    } finally {
      done();
    }
  }
  return [...midiAccess.outputs.values()]
    .find(o => o.name && o.name.includes(MIDI_NAME)) || null;
}
function midiIn() {
  return midiAccess ? [...midiAccess.inputs.values()]
    .find(i => i.name && i.name.includes(MIDI_NAME)) || null : null;
}

// ---- step 1: doorbell over WebMIDI -----------------------------------------
// Once connected over PICOBOOT this button flips to "Put board in MIDI mode"
// and reboots the board back to normal operation instead.
$('btn-bootsel').addEventListener('click', async () => {
  if (picoboot) {
    if (linkBusy) {
      showError('Board busy',
        '<p>A read or write operation is in progress — wait for it to ' +
        'finish before leaving BOOTSEL mode.</p>');
      return;
    }
    expectReboot = true;
    await picoboot.reboot();
    return;                 // the USB disconnect event resets the UI
  }
  try {
    const out = await midiOut('connect-status');
    if (!out) {
      // Not in normal mode — maybe already in BOOTSEL; let the user proceed.
      setStatus('connect-status',
        `No "${MIDI_NAME}" MIDI device found. If the board is already in ` +
        `BOOTSEL mode, just press Connect.`);
      $('btn-connect').disabled = false;
      return;
    }
    out.send(DOORBELL);
    setStatus('connect-status',
      'BOOTSEL request sent — the board is re-enumerating. Press Connect ' +
      'and pick "RP2 Boot" in the browser popup.', 'ok');
    $('btn-bootsel').disabled = true;
    $('btn-connect').disabled = false;
  } catch (e) {
    setStatus('connect-status', 'MIDI access failed: ' + e.message, 'err');
  }
});

// ---- step 2: connect over WebUSB (fresh user gesture required) --------------
let picoboot = null;
let linkBusy = false;       // a verify / upload / flash holds the PICOBOOT link
let expectReboot = false;   // deliberate reboot: don't report it as an unplug
let connecting = false;     // one connect attempt at a time: a second open()
                            // or claim while the first is pending is refused
                            // by Chrome, and the error blames the wrong thing

$('btn-connect').addEventListener('click', async () => {
  if (connecting) return;
  connecting = true;
  $('btn-connect').disabled = true;
  try {
    const dev = await navigator.usb.requestDevice({
      filters: [{ vendorId: RPI_VID, productId: RPI_BOOT_PID }],
    });
    setStatus('connect-status', 'Connecting over PICOBOOT…');
    picoboot = await openPicoboot(dev);
    // Before anything reads the flash: a session cut off in the middle of an
    // upper-half access could have left the flash's upper-half addressing
    // set, and every read below would then land 16 MB too high. The stub
    // clears it (and every later upper-half access clears it again when it
    // ends). forgetStubs first: the SRAM copy of whichever stub ran in an
    // earlier session is gone after a reboot. A board with the 16 MB flash
    // (rev 1.0) has no upper half and may refuse the command; that is
    // harmless there and only reported on the 32 MB part.
    forgetStubs();
    let upperErr = null;
    try { await flash4Reset(picoboot); } catch (err) { upperErr = err; }
    setStatus('connect-status', 'Connected (BOOTSEL / PICOBOOT).', 'ok');
    $('btn-connect').disabled = true;
    $('btn-bootsel').textContent = 'Put board in MIDI mode';
    $('btn-bootsel').disabled = false;
    resetRomCards();
    $('firmware').classList.remove('hidden');
    $('roms').classList.remove('hidden');
    $('settings').classList.remove('hidden');
    $('volume').classList.add('hidden');      // live controls: MIDI mode only
    $('stage').classList.add('hidden');
    setStatus('fw-status', '');
    setStatus('rom-status', '');
    setStatus('settings-status', '');
    await showBoardRev();
    if (upperErr) {
      console.warn('upper-flash reset on connect: ' + upperErr.message);
      if (boardRev.flash !== 'W25Q128')
        setStatus('connect-status',
          'Connected, but the board’s flash did not answer as expected — what ' +
          'this page reads from it may be wrong. Unplug the board, put it back ' +
          'in BOOTSEL mode and connect again.', 'err');
    }
    await showVersion();
    await showSettings();
    renderRomTable();
  } catch (e) {
    if (e instanceof ClaimBlockedError) {
      setStatus('connect-status',
        'The board answered, but this computer would not hand over the ' +
        'PICOBOOT interface — see the driver note.', 'err');
      showError('Windows needs a driver for this board', DRIVER_HELP);
    } else {
      setStatus('connect-status', 'Connect failed: ' + e.message, 'err');
    }
    $('btn-connect').disabled = false;
  } finally {
    connecting = false;
  }
});

// Shown when the interface cannot be claimed. The RP2040 bootloader, unlike
// the RP2350's, carries no MS OS descriptors, so Windows never binds WinUSB
// to its PICOBOOT interface on its own — the same reason picotool asks
// Windows users for Zadig. macOS and Linux need none of this.
const DRIVER_HELP =
  '<p>The board is in BOOTSEL mode and answering, but Windows will not let ' +
  'the browser use its <b>PICOBOOT</b> interface. Windows attaches no driver ' +
  'to that interface by itself. This is a one-time setup, per computer.</p>' +
  '<p><b>The quick route:</b> install ' +
  '<a href="https://zadig.akeo.ie/">Zadig</a>, run it as administrator, ' +
  'tick <i>Options &rarr; List All Devices</i>, choose ' +
  '<b>RP2 Boot (Interface 1)</b> in the dropdown — interface 1, not 0, ' +
  'which is the drive — then pick <b>WinUSB</b> and install.</p>' +
  '<p><b>If Zadig fails</b> — it ships no ARM64 driver package, so it cannot ' +
  'install on ARM versions of Windows — use Device Manager instead: ' +
  'right-click <b>RP2 Boot</b>, <i>Update driver &rarr; Browse &rarr; Let me ' +
  'pick</i>, choose <i>Universal Serial Bus devices</i>, then ' +
  '<b>WinUsb Device</b>. That attaches the driver but not the device ' +
  'interface GUID an application needs, so also run these two lines in an ' +
  '<b>administrator</b> PowerShell:</p>' +
  '<span class="mono">$d = Get-PnpDevice | Where-Object { $_.InstanceId ' +
  '-like \'USB\\VID_2E8A&amp;PID_0003&amp;MI_01*\' }</span>' +
  '<span class="mono">New-ItemProperty -Path ' +
  '"HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$($d.InstanceId)\\Device ' +
  'Parameters" -Name DeviceInterfaceGUIDs -PropertyType MultiString -Value ' +
  '\'{86DFF346-1BBA-47A0-B5CA-18CBB02BEF80}\' -Force</span>' +
  '<p>Then replug the board in BOOTSEL mode, close every Chrome window, and ' +
  'connect again. Flashing firmware by dragging a <code>.uf2</code> onto the ' +
  'RPI-RP2 drive needs none of this — only ROM uploads and settings go ' +
  'through PICOBOOT.</p>';

// Windows-only pointer to the driver setup, so a first-time user meets it
// before a failed connect rather than after one.
{
  const plat = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  if (/win/i.test(plat)) $('win-note').classList.remove('hidden');
  $('win-help').addEventListener('click', e => {
    e.preventDefault();
    showError('Windows needs a driver for this board', DRIVER_HELP);
  });
}

// Yanked cable: reset to the initial state. Any in-flight transfer also hits
// picoboot's own timeout, so whichever fires first ends the operation.
navigator.usb?.addEventListener('disconnect', e => {
  if (!picoboot || e.device !== picoboot.device) return;
  picoboot = null;
  linkBusy = false;
  $('firmware').classList.add('hidden');
  $('roms').classList.add('hidden');
  $('settings').classList.add('hidden');
  $('volume').classList.remove('hidden');
  $('stage').classList.remove('hidden');
  $('fw-progress').classList.add('hidden');
  verifyBar.hide();
  $('btn-flash-fw').disabled = false;
  $('btn-erase-roms').disabled = true;
  $('btn-zip').disabled = true;
  $('btn-bootsel').textContent = 'Put board in BOOTSEL mode';
  $('btn-bootsel').disabled = false;
  $('btn-connect').disabled = true;
  if (expectReboot) {
    expectReboot = false;
    setStatus('connect-status', 'Board rebooted into normal (MIDI) mode.', 'ok');
  } else {
    setStatus('connect-status', 'Board disconnected — plug it back in and start over.', 'err');
  }
});

// On revisit, a previously-granted BOOTSEL device can reconnect silently.
navigator.usb?.getDevices().then(devs => {
  const d = devs.find(d => d.vendorId === RPI_VID && d.productId === RPI_BOOT_PID);
  if (d) {
    $('btn-connect').disabled = false;
    setStatus('connect-status',
      'A board in BOOTSEL mode is already authorized — press Connect.');
  }
});

// ---- version display (RLVR block, read over PICOBOOT) -----------------------
// Decode an RLVR version block (80 bytes) into display text, or null when
// the magic is absent (blank flash, pre-release image, or a UF2 without it).
function versionText(dv) {
  if (dv.byteLength < 80 || dv.getUint32(0, true) !== VER_BLK_MAGIC) return null;
  const str = (off, len) => {
    const b = new Uint8Array(dv.buffer, dv.byteOffset + off, len);
    const end = b.indexOf(0);
    return new TextDecoder().decode(b.subarray(0, end < 0 ? len : end));
  };
  const ver = str(8, 32), git = str(40, 24), date = str(64, 16);
  return `${ver || 'unknown'}${git ? ' (' + git + ')' : ''}${date ? ' · ' + date : ''}`;
}
// The version block inside a parsed UF2, if the file carries the manifest sector.
function uf2VersionText(ranges) {
  const a = FLASH_BASE + VER_BLK_OFF;
  const r = ranges.find(r => r.addr <= a && a + 80 <= r.addr + r.data.length);
  if (!r) return null;
  const o = a - r.addr;
  return versionText(new DataView(r.data.buffer, r.data.byteOffset + o, 80));
}
let installedVersion = null;     // as shown in the Firmware card, for the confirm dialogs

// ---- board revision (JEDEC id of the boot flash, via the EXEC stub) ---------
// boardRev.rev === 0 means "unknown flash part or the stub could not run":
// no gate is applied then, matching the firmware.
let boardRev = { jedec: 0, rev: 0, flash: null, desc: null };
async function showBoardRev() {
  try {
    forgetStubs();
    boardRev = await readBoardRev(picoboot);
    // the LED pulses amber from here until the board reboots (stubs.js)
    try { await ledPulse(picoboot); } catch (e) { console.warn('LED stub: ' + e.message); }
    $('board-rev').textContent = boardRev.rev
      ? `${revText(boardRev.rev)} (${boardRev.desc})`
      : `unknown (flash id ${boardRev.jedec.toString(16).padStart(6, '0')})`;
  } catch (e) {
    boardRev = { jedec: 0, rev: 0, flash: null, desc: null };
    $('board-rev').textContent = 'not determined: ' + e.message;
  }
}
// The minimum board revision a parsed UF2 asks for (its RLVR block, fmt 2), else 0.
function uf2MinHw(ranges) {
  const a = FLASH_BASE + VER_BLK_OFF;
  const r = ranges.find(r => r.addr <= a && a + VER_BLK_LEN <= r.addr + r.data.length);
  if (!r) return 0;
  return minHwFromVerBlk(new DataView(r.data.buffer, r.data.byteOffset + a - r.addr, VER_BLK_LEN));
}

async function showVersion() {
  try {
    const dv = await picoboot.read(FLASH_BASE + VER_BLK_OFF, VER_BLK_LEN);
    installedVersion = versionText(dv);
    $('fw-version').textContent = installedVersion ?? 'none (blank or pre-release image)';
  } catch (e) {
    installedVersion = null;
    $('fw-version').textContent = 'read failed: ' + e.message;
  }
  // Firmware integrity: the whole slot is read back and CRC-checked the way
  // the firmware checks itself at boot.
  const el = $('fw-check');
  el.className = 'mono';
  try {
    el.textContent = 'checking…';
    const r = fwCheck(await readFlash(0, FW_SLOT));
    if (r.state === 'ok') {
      el.textContent = `verified (${r.len.toLocaleString()} bytes, CRC-32 ${hex8(r.crc)})`;
      el.classList.add('ok');
    } else if (r.state === 'corrupt') {
      el.textContent = `CORRUPT — reflash the firmware (expected ${hex8(r.crc)}, computed ${hex8(r.got)})`;
      el.classList.add('err');
    } else el.textContent = 'not available (this firmware predates the self-check)';
  } catch (e) {
    el.textContent = 'read failed: ' + e.message;
  }
}

// ---- settings (own 4K sector, read-modify-write over PICOBOOT) -------------
// The persona name is the firmware's to write; the flasher only edits the
// interface flags and carries the name through unchanged.
let settings = null;

async function showSettings() {
  try {
    const dv = await picoboot.read(FLASH_BASE + SETTINGS_OFF, RECORD_LEN);
    settings = decodeSettings(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    $('set-vendor').checked = !!(settings.flags & FLAG_USB_VENDOR);
    $('set-audio').checked = !!(settings.flags & FLAG_USB_AUDIO);
    $('set-volume-note').textContent =
      `Stored volume: ${volumeLabel(settings.volume)} — set it live from the ` +
      'Volume card once the board is back in MIDI mode; saving here keeps it.';
    $('btn-save-settings').disabled = false;
  } catch (e) {
    settings = null;
    $('btn-save-settings').disabled = true;
    setStatus('settings-status', 'read failed: ' + e.message, 'err');
  }
}

$('btn-save-settings').addEventListener('click', async () => {
  if (!picoboot || !settings) return;
  if (linkBusy) {
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before saving settings.</p>');
    return;
  }
  const flags = ($('set-vendor').checked ? FLAG_USB_VENDOR : 0) |
                ($('set-audio').checked ? FLAG_USB_AUDIO : 0) |
                (settings.flags & FLAG_ANALOG_MASK);     // the firmware's (live card); carried through
  linkBusy = true;
  $('btn-save-settings').disabled = true;
  try {
    // Re-read first: the record may have changed since connect (it never
    // does while in BOOTSEL, but the name must be the board's, not ours).
    const dv = await picoboot.read(FLASH_BASE + SETTINGS_OFF, RECORD_LEN);
    const cur = decodeSettings(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    const rec = encodeSettings({ flags, lastPersona: cur.lastPersona, volume: cur.volume });
    const page = new Uint8Array(PAGE).fill(0xff);
    page.set(rec);
    await picoboot.erase(FLASH_BASE + SETTINGS_OFF, SECTOR);
    await picoboot.write(FLASH_BASE + SETTINGS_OFF, page);
    const back = await picoboot.read(FLASH_BASE + SETTINGS_OFF, RECORD_LEN);
    const b = new Uint8Array(back.buffer, back.byteOffset, back.byteLength);
    for (let i = 0; i < RECORD_LEN; i++)
      if (b[i] !== rec[i]) throw new Error('verify failed');
    settings = { flags, lastPersona: cur.lastPersona, volume: cur.volume, valid: true };
    setStatus('settings-status',
      'Saved — takes effect when the board leaves BOOTSEL mode.', 'ok');
  } catch (err) {
    if (picoboot) setStatus('settings-status', 'Save failed: ' + err.message, 'err');
  } finally {
    linkBusy = false;
    $('btn-save-settings').disabled = !picoboot;
  }
});

// ---- volume (live, MIDI mode) ----------------------------------------------
// 128 steps of 0.5 dB, 127 = 0 dB, 0 = mute; the board persists the last
// value itself (idle auto-save), so nothing is written from here. The
// current level is read back with the query SysEx: on load when MIDI access
// was granted earlier (no prompt then), after the first Set otherwise, and
// again whenever the board (re)appears as a MIDI device. Until a reply
// arrives the readout says so instead of guessing.
function volumeLabel(v) {
  return v === 0 ? '0 · mute' : `${v} · ${(-0.5 * (VOLUME_MAX - v)).toFixed(1)} dB`;
}
let volumeKnown = false, stageKnown = false;
function showVolume() {
  const v = +$('vol-slider').value;
  $('vol-value').textContent = volumeKnown ? volumeLabel(v) : `${volumeLabel(v)} (not read)`;
}
$('vol-slider').addEventListener('input', showVolume);
showVolume();

let queryTimer = null;
let readingDone = () => {};
function onMidiMessage(e) {
  const d = e.data;
  if (d.length === 7 && d[0] === 0xF0 && d[1] === 0x7D && d[2] === 0x52 &&
      d[3] === 0x4C && d[4] === 0x04 && d[6] === 0xF7) {
    clearTimeout(queryTimer);
    readingDone();
    volumeKnown = true;
    $('vol-slider').value = Math.min(d[5], VOLUME_MAX);
    showVolume();
    setStatus('volume-status', '');
  }
  if (d.length === 7 && d[0] === 0xF0 && d[1] === 0x7D && d[2] === 0x52 &&
      d[3] === 0x4C && d[4] === 0x06 && d[6] === 0xF7) {
    stageKnown = true;
    $('stage-mt').checked = !!(d[5] & 1);
    $('stage-sc').checked = !!(d[5] & 2);
    $('stage-mt').disabled = false;
    $('stage-sc').disabled = false;
    setStatus('stage-status', '');
  }
}
// Ask the board for its level; silent when it is not in MIDI mode. The
// query is repeated every QUERY_MS until a reply lands — a board that has
// just (re)appeared on USB may not be draining MIDI yet, and a single lost
// query must not paint an error that the next reply wipes a moment later.
// Only after QUERY_TRIES unanswered queries is the no-answer message shown.
const QUERY_MS = 500, QUERY_TRIES = 6;
async function queryVolume() {
  try {
    const out = await midiOut('volume-status');
    const inp = midiIn();
    if (!out || !inp) return;
    inp.onmidimessage = onMidiMessage;
    volumeKnown = false; stageKnown = false;
    $('stage-mt').disabled = true; $('stage-sc').disabled = true;
    clearTimeout(queryTimer);
    readingDone();
    readingDone = slowStatus('volume-status', 'Reading the current level…');
    let tries = 0;
    const tick = () => {
      if (volumeKnown) return;
      if (tries++ >= QUERY_TRIES) {
        readingDone();
        setStatus('volume-status',
          'No answer from the board — its firmware may predate the volume control.', 'err');
        return;
      }
      out.send(VOLUME_QUERY);
      if (!stageKnown) out.send(STAGE_QUERY);   // older firmware: no reply, box stays disabled
      queryTimer = setTimeout(tick, QUERY_MS);
    };
    tick();
  } catch (e) {
    /* no MIDI access: nothing to show until the user presses Set */
  }
}
// On load: only if the permission was granted before (no prompt on a plain
// page view); then follow device arrivals, e.g. the board leaving BOOTSEL.
let watching = false;
function watchArrivals() {
  if (watching || !midiAccess) return;
  watching = true;
  midiAccess.addEventListener('statechange', e => {
    if (e.port.type === 'input' && e.port.state === 'connected' &&
        e.port.name && e.port.name.includes(MIDI_NAME))
      setTimeout(queryVolume, 300);      // let the output port appear too
  });
}
navigator.permissions?.query({ name: 'midi', sysex: true }).then(async st => {
  if (st.state !== 'granted') return;
  await queryVolume();
  watchArrivals();
}).catch(() => { /* no permissions API for midi: wait for the first Set */ });

// Vintage output stage: one SysEx per click carrying both family bits,
// live; the board persists them with the volume's idle auto-save. The boxes
// are enabled by the query reply, so a firmware without the stage never
// gets switches it would ignore.
async function sendStage(box) {
  const mt = $('stage-mt').checked, sc = $('stage-sc').checked;
  try {
    const out = await midiOut('stage-status');
    if (!out) { box.checked = !box.checked; return; }
    out.send(STAGE_SYX((mt ? 1 : 0) | (sc ? 2 : 0)));
    setStatus('stage-status',
      `MT-32 / CM-32L ${mt ? 'on' : 'off'}, SC-55 ${sc ? 'on' : 'off'} — the board stores it after a few idle seconds.`, 'ok');
  } catch (e) {
    box.checked = !box.checked;
    setStatus('stage-status', 'MIDI access failed: ' + e.message, 'err');
  }
}
$('stage-mt').addEventListener('change', e => sendStage(e.target));
$('stage-sc').addEventListener('change', e => sendStage(e.target));

$('btn-set-volume').addEventListener('click', async () => {
  const v = Math.min(Math.max(+$('vol-slider').value, 0), VOLUME_MAX);
  $('btn-set-volume').disabled = true;
  try {
    const out = await midiOut('volume-status');
    if (!out) {
      setStatus('volume-status',
        `No "${MIDI_NAME}" MIDI device found — the board must be plugged in ` +
        'and in normal (MIDI) mode, not BOOTSEL.', 'err');
      return;
    }
    const inp = midiIn();
    if (inp) inp.onmidimessage = onMidiMessage;
    out.send(VOLUME_SYX(v));
    volumeKnown = true;                 // what we just sent is the level now
    showVolume();
    setStatus('volume-status',
      `Volume ${volumeLabel(v)} sent — the board stores it after a few idle seconds.`, 'ok');
    watchArrivals();                    // permission is granted from here on
  } catch (e) {
    setStatus('volume-status', 'MIDI access failed: ' + e.message, 'err');
  } finally {
    $('btn-set-volume').disabled = false;
  }
});

// ---- firmware flash (M4) ----------------------------------------------------
$('btn-flash-fw').addEventListener('click', () => {
  if (linkBusy) {
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before flashing firmware.</p>');
    return;
  }
  $('fw-file').click();
});
$('fw-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  e.target.value = '';
  if (linkBusy) {     // an operation started while the file picker was open
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before flashing firmware.</p>');
    return;
  }
  const bar = $('fw-progress');
  try {
    const ranges = parseUf2(await f.arrayBuffer());
    const total = ranges.reduce((a, r) => a + r.data.length, 0);
    const hits = (lo, hi) => ranges.some(r => r.addr < hi && r.addr + r.data.length > lo);
    const wipesRoms = romExtents().some(([lo, hi]) => hits(FLASH_BASE + lo, FLASH_BASE + hi));
    const wipesSettings = hits(FLASH_BASE + SETTINGS_OFF, FLASH_BASE + SETTINGS_OFF + SECTOR);
    const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    // A UF2 reaches the first 16 MB only (the bootloader's 3-byte
    // addresses); refuse anything else before a single sector is erased,
    // rather than fail half way through.
    if (ranges.some(r => r.addr < FLASH_BASE || r.addr + r.data.length > FLASH_BASE + UPPER_BASE)) {
      showError('This file cannot be flashed',
        `<p><b>${esc(f.name)}</b> writes outside the part of the flash a firmware ` +
        'file can reach. Nothing was written. Use a release file.</p>');
      setStatus('fw-status', 'Refused — the file writes outside the firmware area.', 'err');
      return;
    }
    // Board-revision gate: an image that needs a newer board than this one
    // is refused before anything is written. Firmware v1.1.0+ images need
    // the rev 1.1 (PSRAM) board; on a rev 1.0 board they would boot mute.
    // Integrity of the firmware in the file itself: a damaged download or a
    // mis-saved UF2 is refused here rather than flashed into an SOS.
    const fwImg = uf2Firmware(ranges);
    const fileCheck = fwImg ? fwCheck(fwImg) : { state: 'none' };
    if (fileCheck.state === 'corrupt') {
      showError('This file is damaged',
        `<p>The firmware inside <b>${esc(f.name)}</b> fails its integrity check ` +
        `(expected CRC-32 ${hex8(fileCheck.crc)}, computed ${hex8(fileCheck.got)}).</p>` +
        '<p>Nothing was written. Download the release file again.</p>');
      setStatus('fw-status', 'Refused — the file is damaged.', 'err');
      return;
    }
    const needHw = uf2MinHw(ranges);
    if (needHw && boardRev.rev && boardRev.rev < needHw) {
      showError('This image does not fit this board',
        `<p><b>${esc(f.name)}</b> needs board revision ${revText(needHw)} or newer. ` +
        `This board is revision ${revText(boardRev.rev)} (${boardRev.desc}).</p>` +
        '<p>Nothing was written. Use a release made for your board revision.</p>');
      setStatus('fw-status', 'Refused — image needs a newer board revision.', 'err');
      return;
    }
    const versions =
      '<table class="vers">' +
      `<tr><td>Installed now</td><td class="mono">${esc(installedVersion ?? 'none (blank or pre-release image)')}</td></tr>` +
      `<tr><td>In this file</td><td class="mono">${esc(uf2VersionText(ranges) ?? 'no version block')}</td></tr>` +
      (fileCheck.state === 'ok' ? `<tr><td>File check</td><td class="mono">firmware verified (CRC-32 ${hex8(fileCheck.crc)})</td></tr>` : '') +
      (needHw ? `<tr><td>Needs board</td><td class="mono">${esc(revText(needHw))}` +
                (boardRev.rev ? ` — this board: ${esc(revText(boardRev.rev))}` : ' — this board: unknown') +
                '</td></tr>' : '') +
      '</table>';
    let ok;
    if (wipesRoms || wipesSettings) {
      ok = await confirmDialog('This is the full recovery image',
        `<p><b>${esc(f.name)}</b> rewrites the whole flash, not just the firmware.</p>` +
        versions +
        (wipesRoms ? '<p><b>Every ROM you have uploaded will be erased</b> ' +
          'and has to be uploaded again afterwards.</p>' : '') +
        (wipesSettings ? '<p>Settings — USB interfaces, volume, the remembered ' +
          'mode — go back to their defaults.</p>' : '') +
        '<p>The normal update file (without <code>-full</code>) keeps ROMs ' +
        'and settings. Only use this one for a card in an unknown state.</p>',
        'Flash the full image');
    } else {
      ok = await confirmDialog('Flash this firmware?',
        `<p><b>${esc(f.name)}</b> updates the firmware and the sound ` +
        'engines. Your uploaded ROMs and your settings are kept.</p>' + versions +
        '<p>The board reboots when the flash has been verified.</p>',
        'Flash');
    }
    if (!ok) { setStatus('fw-status', 'Cancelled — nothing was written.'); return; }
    setStatus('fw-status',
      `${f.name}: ${ranges.length} region(s), ${total.toLocaleString()} flash bytes`);
    bar.classList.remove('hidden');
    $('btn-flash-fw').disabled = true;
    linkBusy = true;
    await flashUf2(picoboot, ranges, (frac, label) => {
      bar.value = Math.round(frac * 100);
      setStatus('fw-status', `${label}… ${Math.round(frac * 100)}%`);
    }, (a, n, f) => blockErase(picoboot, a, n, f));
    setStatus('fw-status', 'Flashed and verified — rebooting the board.', 'ok');
    expectReboot = true;
    await picoboot.reboot();
    bar.classList.add('hidden');
  } catch (err) {
    bar.classList.add('hidden');
    $('btn-flash-fw').disabled = false;
    setStatus('fw-status', 'Flash failed: ' + err.message, 'err');
  } finally {
    linkBusy = false;
  }
});

// ---- Footer: which commit this copy of the flasher is ------------------------
// build.json carries Jekyll front matter; the GitHub Pages build fills in the
// SHA of the commit it deployed (jekyll-github-metadata's build_revision) and
// the build time. A copy served from a plain checkout gets the raw file,
// which is not JSON, so the footer stays quiet there.
fetch('build.json', { cache: 'no-cache' }).then(r => r.json()).then(b => {
  const sha = /^[0-9a-f]{40}$/.test(b.rev ?? '') ? b.rev : null;
  if (!sha) return;
  const el = $('build-info');
  const a = document.createElement('a');
  a.href = `https://github.com/eivindbohler/rollin-llama/commit/${sha}`;
  a.textContent = sha.slice(0, 7);
  a.title = `Deployed from commit ${sha}`;
  el.append('Flasher build ', a);
  if (b.built) el.append(` · ${b.built}`);
}).catch(() => {});

// ---- ROM section ------------------------------------------------------------
let manifest = null, pushTable = null, fwTables = null;

// ---- flash access, routed by half --------------------------------------------
// Offsets are flash offsets. The lower 16 MB goes through PICOBOOT and the
// bootrom-based stubs as always; the upper 16 MB (UPPER_BASE and up, map
// v8: the SC-55 mk2 waves + ROM 2 and the gs2k samples) only through the
// flash4 stub — the bootrom path would silently wrap an upper offset onto
// the firmware end of the chip. A range that straddles the boundary is
// split. Every persona-data access below goes through these four.
function byHalf(off, n) {
  if (off >= UPPER_BASE || off + n <= UPPER_BASE) return [{ off, n, upper: off >= UPPER_BASE }];
  return [{ off, n: UPPER_BASE - off, upper: false }, { off: UPPER_BASE, n: off + n - UPPER_BASE, upper: true }];
}
async function eachHalf(off, n, progress, fn) {
  let done = 0;
  for (const h of byHalf(off, n)) {
    await fn(h, f => progress && progress((done + f * h.n) / n));
    done += h.n;
  }
}

async function readFlash(off, size, progress) {
  const out = new Uint8Array(size);
  await eachHalf(off, size, progress, async (h, prog) => {
    if (h.upper) { out.set(await flash4Read(picoboot, h.off, h.n, prog), h.off - off); return; }
    const CHUNK = 4096;
    for (let o = 0; o < h.n; o += CHUNK) {
      const n = Math.min(CHUNK, h.n - o);
      const dv = await picoboot.read(FLASH_BASE + h.off + o, n);
      out.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), h.off - off + o);
      prog((o + n) / h.n);
    }
  });
  return out;
}

// Erase [off, off + count): 4 KB aligned, like both stubs require.
async function eraseFlash(off, count, progress) {
  if ((off | count) % SECTOR) throw new Error('erase range not sector aligned');
  await eachHalf(off, count, progress, (h, prog) => h.upper
    ? flash4Erase(picoboot, h.off, h.n, prog)
    : blockErase(picoboot, FLASH_BASE + h.off, h.n, prog));
}

// Program erased flash. Lower half in 4 KB PICOBOOT writes; the last one
// is padded with FF to a whole 256-byte page (the bootrom programs pages,
// and FF leaves erased flash as it is).
async function writeFlash(off, data, progress) {
  await eachHalf(off, data.length, progress, async (h, prog) => {
    const part = data.subarray(h.off - off, h.off - off + h.n);
    if (h.upper) { await flash4Write(picoboot, h.off, part, prog); return; }
    for (let o = 0; o < h.n; o += SECTOR) {
      let chunk = part.subarray(o, Math.min(o + SECTOR, h.n));
      if (chunk.length % PAGE) {
        const padded = new Uint8Array(chunk.length + PAGE - chunk.length % PAGE).fill(0xff);
        padded.set(chunk);
        chunk = padded;
      }
      await picoboot.write(FLASH_BASE + h.off + o, chunk);
      prog(Math.min(o + SECTOR, h.n) / h.n);
    }
  });
}

// The board's push hash over [{ flashOff, bytes, hwAddr }]: the quad-XIP
// hash stub when everything is in the lower half (fastest), the flash4
// stub's when any image reaches the upper half (same value, any offset).
function hashImages(images, progress) {
  return hasUpper(images) ? flash4Hash(picoboot, images, progress)
                          : hashPersona(picoboot, images, progress);
}

// Two 256-byte reads, start and middle: an erased region is FF everywhere,
// real data (even data that begins with an FF run) is not.
async function regionBlank(off, len) {
  const p0 = await readFlash(off, 256);
  const p1 = await readFlash((off + (len >> 1)) & ~0xff, 256);
  return p0.every(b => b === 0xff) && p1.every(b => b === 0xff);
}

function personaRecord(id) {
  return manifest?.personas.find(pr => pr.name === id);
}
// The RLPH entry for a persona's record, or null when the image has none.
function expectedHash(rec) {
  const pidx = manifest ? manifest.personas.indexOf(rec) : -1;
  return pushTable && pidx >= 0 && pidx < pushTable.length ? pushTable[pidx] : null;
}

// The CM-32L PCM ROM begins with the MT-32 PCM ROM: the board stores that
// half once and both personas use it, so either upload fills it. Shown on
// both rows; the CM-32L row also shows a half-filled dot when only that
// half is there (SHARED_HALF).
const ROW_NOTES = {
  'MT32_PCM.ROM':  'Also the first half of the CM-32L PCM ROM — uploading either fills it.',
  'CM32L_PCM.ROM': 'Its first half is the MT-32 PCM ROM, shared with the MT-32.',
};
const SHARED_HALF = { 'CM32L_PCM.ROM': { part: 0, sameAs: 'MT32_PCM.ROM' } };

// MU2000 (persona gs2k): its six ROM files do not map one-to-one onto what
// the board stores. The converter (gs2kpack.js) combines them into the
// sample data (the pushed image, upper half in map v8) and the control
// tables (the FW_TABLE_HW image the firmware reads in place, lower half).
// So accepted files are held in memory for the session, the pack is built
// and written once all six are here, and the persona is verified as a
// whole: the samples by the board's push hash against the RLPH entry, the
// control tables by read-back against their expected CRC-32 and length from
// the image's table-hash block (RLFT; on an older image without it: against
// the bytes built here, or non-blank and the "GS2K" magic). Since 2026-11-05 the
// converter also builds the effects section (MEG2, raw program-ROM slices),
// so the control tables are complete, reverb and chorus included.
const GS2K = 'gs2k';
const GS2K_MAGIC = [0x47, 0x53, 0x32, 0x4b];   // 'GS2K', ctl.bin byte 0
const gs2kFiles = new Map();     // reference name -> Uint8Array, accepted this session
let gs2kCtl = null;              // the control tables built (and written) this session
let gs2kOk = false;              // the persona verified on the board
let gs2kRetry = false;           // a full set is held but the board lacks it after a write or a check:
                                 // only then the card offers "Write to board"
const gs2kRoms = () => REFERENCE_ROMS.filter(r => r.set === GS2K);
const gs2kAllHeld = () => gs2kRoms().every(r => gs2kFiles.has(r.name));
let uploadsOn = false;           // mirrors setUploadsEnabled(), for the note's button

// The persona cards are static (reference table) and built once, at page
// load, so the ROMs section never appears empty or collapses between a
// (re)connect and the first verification — rebuilding them per connect made
// the section blink out while the manifest was being read.
function buildRomTable() {
  const list = $('rom-list');
  list.innerHTML = '';
  for (const p of PERSONAS) {
    const card = document.createElement('div');
    card.className = 'subcard';
    let rows = '<tr><th>ROM</th><th style="text-align:right">Size</th>' +
               '<th>Reference SHA-1</th><th></th></tr>';
    for (const r of REFERENCE_ROMS.filter(r => r.set === p.set)) {
      rows +=
        `<tr><td><span class="dot" data-dot="${r.name}"></span>${r.label}` +
        (ROW_NOTES[r.name] ? `<span class="rnote">${ROW_NOTES[r.name]}</span>` : '') + `</td>` +
        `<td class="mono">${r.size.toLocaleString()}</td>` +
        `<td class="mono">${r.sha1}</td>` +
        `<td><button data-upload="${r.name}" disabled>Upload…</button></td></tr>`;
    }
    card.innerHTML =
      `<div class="phead"><b>${p.label} <span class="pver">(${p.version})</span></b>` +
      `<span class="mono pstatus" data-persona-status="${p.id}"></span></div>` +
      `<table>${rows}</table>` +
      (p.id === GS2K ? `<div class="pnote" data-persona-note="${p.id}"></div>` : '');
    list.appendChild(card);
  }
  list.onclick = onRomListClick;
  renderGs2kNote();
}
buildRomTable();

// Back to "checking…" — done the moment the section is shown on connect,
// so a reconnect never shows the previous session's dots.
function resetRomCards() {
  document.querySelectorAll('.dot').forEach(d => d.className = 'dot');
  document.querySelectorAll('[data-persona-status]').forEach(el => {
    el.textContent = 'checking…'; el.className = 'mono pstatus';
  });
}

// On connect: read the manifest, verify.
async function renderRomTable() {
  try {
    const mdv = await picoboot.read(FLASH_BASE + MANIFEST_OFF, 512);
    manifest = parseManifest(mdv);
    const pdv = await picoboot.read(FLASH_BASE + PUSH_TBL_OFF, 64);
    pushTable = parsePushTable(pdv);
    fwTables = parseFwTables(await picoboot.read(FLASH_BASE + FWTAB_TBL_OFF, 64));
  } catch (e) {
    setStatus('rom-status', 'could not read the board’s ROM layout: ' + e.message, 'err');
  }
  await verifyAll();
  setUploadsEnabled(true);
}

// Only one PICOBOOT conversation at a time: the upload buttons stay disabled
// while the verify cascade or another upload holds the link.
let batchUpload = false;     // a zip upload is running: uploadRom's own re-enable must not flicker the buttons
function setUploadsEnabled(on) {
  on = on && !batchUpload;
  uploadsOn = on;
  document.querySelectorAll('button[data-upload]')
    .forEach(b => b.disabled = !on);
  renderGs2kNote();              // "Write to board" is shown only while it can be used
  const haveManifest = (manifest?.personas ?? []).some(p => p.images.length);
  $('btn-erase-roms').disabled = !on || !haveManifest;
  $('btn-zip').disabled = !on || !haveManifest;
}

// Overall ROM-verification progress, next to the Connect button: the
// read-back after connect takes a while and the per-persona spinners sit
// further down the page. Shown only while the cascade runs; weighted by
// bytes to read; a persona that is skipped (blank slot, no manifest entry)
// counts as done.
const verifyBar = {
  show() {
    $('verify-progress').value = 0;
    $('verify-label').textContent = 'Verifying ROMs…';
    $('verify-wrap').classList.remove('hidden');
  },
  set(frac) {
    const pct = Math.round(100 * Math.min(Math.max(frac, 0), 1));
    $('verify-progress').value = pct;
    $('verify-label').textContent = `Verifying ROMs… ${pct}%`;
  },
  hide() { $('verify-wrap').classList.add('hidden'); },
};
function personaBytes(id) {
  if (id === GS2K) return (personaRecord(id)?.images ?? []).reduce((a, im) => a + im.bytes, 0);
  const plan = filePlan(id);
  return Object.values(plan).reduce((a, f) => a + f.parts.reduce((b, pt) => b + pt.len, 0), 0);
}

// The board stores derived per-persona images (the manifest's extents), not
// individual files, so on-board state is judged per persona: a quick blank
// probe, then an automatic full read-back against the card's own expected
// content hash — the same check the firmware runs on every boot.
async function verifyAll() {
  const t0 = performance.now();
  linkBusy = true;
  const grand = PERSONAS.reduce((a, p) => a + personaBytes(p.id), 0);
  let before = 0;
  verifyBar.show();
  try {
    for (const p of PERSONAS) {
      const mine = personaBytes(p.id);
      try {
        await verifyPersona(p.id, f => verifyBar.set((before + f * mine) / grand));
      } catch (e) {
        // Read failed (timeout / unplug): stop the cascade, mark what's left.
        document.querySelectorAll('.dot.busy').forEach(d => d.className = 'dot err');
        const el = document.querySelector(`[data-persona-status="${p.id}"]`);
        if (el) { el.textContent = ''; el.className = 'mono pstatus'; }
        if (picoboot)   // disconnect handler already explains the unplug case
          setStatus('rom-status', 'Verification aborted: ' + e.message, 'err');
        return;
      }
      before += mine;
      verifyBar.set(before / grand);
    }
    console.log(`verifyAll: ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  } finally {
    verifyBar.hide();          // visible only while a verification is running
    linkBusy = false;
  }
}

// How many of a persona's FILES are absent: a file counts as blank when the
// start and the middle of each of its flash parts read all FF (real ROMs can
// begin with FF runs, an erased slot is FF everywhere). Per file, not per
// image extent: the SC-55 wave ROMs share one extent, and an extent probe
// that saw two of three in place sent the whole-persona hash on a doomed
// run after every upload of the second-to-last file ("verifying" twice).
// A part no manifest image covers counts as present, so the read-back
// reports it rather than "ROMs missing". Two 256-byte reads per part.
async function blankFiles(id, rec) {
  let blank = 0;
  for (const fp of Object.values(filePlan(id, rec))) {
    let allBlank = true;
    for (const pt of fp.parts) {
      const im = rec.images.find(im => im.hwAddr === pt.hw);
      if (!im || !await regionBlank(im.flashOff + pt.off, pt.len)) { allBlank = false; break; }
    }
    if (allBlank) blank++;
  }
  return blank;
}

// `onFrac` reports 0..1 of this persona's read-back (1 when skipped).
async function verifyPersona(id, onFrac = () => {}) {
  const el = document.querySelector(`[data-persona-status="${id}"]`);
  const dot = name => document.querySelector(`[data-dot="${name}"]`);
  const p = PERSONAS.find(p => p.id === id);
  const files = REFERENCE_ROMS.filter(r => r.set === p.set);
  const rec = personaRecord(id);
  if (id === GS2K) return verifyGs2k(rec, onFrac);
  if (!rec || !rec.images.length) {
    el.textContent = 'not supported by the installed firmware';
    el.className = 'mono pstatus err';
    files.forEach(r => dot(r.name).className = 'dot err');
    return;
  }
  // Blank probe per file (blankFiles). Every file blank = nothing uploaded
  // yet. SOME blank = a partial upload: the persona cannot hash, so skip
  // the stub and read back per file, which shows WHICH ROMs are in place
  // (a blank extent used to fail the whole persona as "missing", which
  // read as if the uploaded file had vanished).
  const blank = await blankFiles(id, rec);
  if (blank === files.length) {
    el.textContent = 'ROMs missing — upload below';
    el.className = 'mono pstatus err';
    files.forEach(r => dot(r.name).className = 'dot err');
    return;
  }
  // Fast path: the board hashes the persona's images itself (stubs.js) and
  // the result is compared with the RLPH entry the image carries — the
  // firmware's own boot-time check, ~1 s per persona instead of a USB
  // read-back. A match proves every file at once; a mismatch (or an image
  // without the table) falls through to the file-granular read-back, which
  // says WHICH file is wrong. A persona with data in the upper half is
  // hashed by the flash4 stub (hashImages).
  const expect = expectedHash(rec);
  if (blank === 0 && expect !== null && expect !== 0n) {
    files.forEach(r => dot(r.name).className = 'dot busy');
    el.textContent = 'verifying…';
    await new Promise(res => setTimeout(res));
    let got = null;
    try {
      got = await hashImages(pushedImages(rec), f => {
        el.textContent = `verifying… ${Math.round(100 * f)}%`;
        onFrac(f);
      });
    } catch (e) { console.warn(`hash stub (${id}): ${e.message}; reading back instead`); }
    if (got === expect) {
      files.forEach(r => dot(r.name).className = 'dot ok');
      el.textContent = ''; el.className = 'mono pstatus';
      onFrac(1);
      return;
    }
    if (got !== null) console.log(`hash stub (${id}): ${got.toString(16)} != ${expect.toString(16)}, reading back`);
  }
  // File-granular verification, strictly in page order: each ROM's own
  // backing byte ranges are read (files partition the images, so every byte
  // is still read exactly once), reconstructed and hashed — one spinner at
  // a time, one flip per ROM.
  const plan = filePlan(id, rec);
  const grand = files.reduce((a, r) =>
    a + plan[r.name].parts.reduce((b, pt) => b + pt.len, 0), 0);
  let done = 0, ok = 0;
  for (const r of files) {
    dot(r.name).className = 'dot busy';
    await new Promise(res => setTimeout(res));   // paint the spinner
    const len = plan[r.name].parts.reduce((a, pt) => a + pt.len, 0);
    const good = await readAndCheckFile(rec, r, plan[r.name], f => {
      el.textContent =
        `verifying… ${Math.round(100 * (done + f * len) / grand)}%`;
      onFrac((done + f * len) / grand);
    });
    done += len;
    dot(r.name).className = 'dot ' + (good === true ? 'ok' : good === 'half' ? 'half' : 'err');
    dot(r.name).title = good === 'half'
      ? 'First half in place (shared with the MT-32 PCM ROM). Upload this ROM for the rest.' : '';
    if (good === true) ok++;
  }
  const all = ok === files.length;
  el.textContent = all ? '' : `${ok}/${files.length} verified`;
  el.className = 'mono pstatus ' + (all ? '' : 'err');
}

// Read one ROM's backing flash ranges, reconstruct the original file bytes
// via the inverse transform, and check size + SHA-1. `onFrac` gets 0..1 of
// this file's read progress. Returns true, false, or 'half' for a file
// whose shared part (SHARED_HALF) is in place and the rest is not.
async function readAndCheckFile(rec, r, plan, onFrac) {
  const chunks = [];
  const total = plan.parts.reduce((a, pt) => a + pt.len, 0);
  let done = 0;
  for (const pt of plan.parts) {
    const im = rec.images.find(im => im.hwAddr === pt.hw);
    if (!im || pt.off + pt.len > im.bytes) return false;
    const raw = await readFlash(im.flashOff + pt.off, pt.len,
      f => onFrac && onFrac((done + f * pt.len) / total));
    done += pt.len;
    chunks.push(applyXform(plan.xform, raw));
  }
  let data = chunks[0];
  if (chunks.length > 1) {
    data = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of chunks) { data.set(c, o); o += c.length; }
  }
  if (data.length === r.size && await sha1hex(data) === r.sha1) return true;
  const sh = SHARED_HALF[r.name];
  const ref = sh && REFERENCE_ROMS.find(x => x.name === sh.sameAs);
  if (ref && chunks[sh.part]?.length === ref.size && await sha1hex(chunks[sh.part]) === ref.sha1)
    return 'half';
  return false;
}

// True when the flash already holds exactly these bytes for this part, so
// the upload can leave it alone: the CM-32L PCM ROM's first half IS the
// MT-32 PCM ROM (one copy, shared), so whichever of the two came first, the
// other writes only what is missing, and a re-upload writes nothing. A
// blank probe first (two 256-byte reads, as blankFiles), then the board
// hashes the range itself (hash stub, or the flash4 stub's in the upper
// half) against the same hash of the bytes we would write. Any doubt (stub
// error) = not in place = write it.
async function partInPlace(im, pt, bytes) {
  if (await regionBlank(im.flashOff + pt.off, pt.len)) return false;
  const hw = pt.hw + (pt.off >> 1);
  try {
    const got = await hashImages([{ flashOff: im.flashOff + pt.off, bytes: pt.len, hwAddr: hw }]);
    return got === pushHash([{ hwAddr: hw, data: bytes }]);
  } catch (e) {
    console.warn(`hash stub: ${e.message}; writing the part`);
    return false;
  }
}

// ---- upload flow ------------------------------------------------------------
// The push-hash table (RLPH) baked into the manifest describes the reference
// dumps; a different dump would fail the boot-time push check (red LED). So
// this flasher REFUSES non-reference files.
let pendingUpload = null;

function onRomListClick(e) {
  if (!picoboot) return;
  if (e.target.dataset?.gs2kWrite !== undefined) return writeGs2k();   // the MU2000 card's "Write to board"
  const name = e.target.dataset?.upload;
  if (!name) return;
  pendingUpload = name;
  $('rom-file').value = '';
  $('rom-file').click();
}

$('rom-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  const name = pendingUpload;
  pendingUpload = null;
  if (f && name) await uploadRom(name, f);
});

const escHtml = s => s.replace(/[<>&]/g,
  c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function showError(title, html) {
  $('rom-error-title').textContent = title;
  $('rom-error-msg').innerHTML = html;
  $('rom-error').showModal();
}

// Erase every ROM on the board: per flash half, the span of the manifest's
// image extents with the bitstreams cut out (romEraseSpans — map v8 keeps
// the gs2k bitstream between ROM images; firmware, manifest and settings
// sit below every span), the lower half through the block-erase stub, the
// upper half through the flash4 stub. Then the connect-time verification
// runs again and shows every persona as "ROMs missing". Spans start and
// end on slot boundaries, so both stubs erase in 64 KB blocks.
$('btn-erase-roms').addEventListener('click', async () => {
  if (!picoboot || linkBusy) return;
  let spans;
  try { spans = romEraseSpans(manifest); } catch (err) {
    showError('Nothing was erased', `<p>The ROM areas on this board could not be told apart from the rest: ${escHtml(err.message)}.</p>`);
    return;
  }
  const total = spans.reduce((a, [lo, hi]) => a + hi - lo, 0);
  const present = [];
  for (const p of PERSONAS) {
    const dots = REFERENCE_ROMS.filter(r => r.set === p.set)
      .map(r => document.querySelector(`[data-dot="${r.name}"]`)?.className ?? '');
    if (dots.some(c => c.includes('ok'))) present.push(p.label);
  }
  const ok = await confirmDialog('Erase all ROMs?',
    '<p>This erases <b>every ROM uploaded to the board</b>' +
    (present.length ? ` (${present.map(escHtml).join(', ')})` : '') +
    '. No persona will start until its ROMs are uploaded again.</p>' +
    '<p>Firmware, the sound engines and your settings are kept.</p>',
    'Erase all ROMs');
  if (!ok) { setStatus('rom-status', 'Cancelled — nothing was erased.'); return; }
  setUploadsEnabled(false);
  linkBusy = true;
  document.querySelectorAll('.dot').forEach(d => d.className = 'dot busy');
  document.querySelectorAll('[data-persona-status]').forEach(el => { el.textContent = 'erasing…'; el.className = 'mono pstatus'; });
  try {
    let done = 0;
    for (const [lo, hi] of spans) {
      await eraseFlash(lo, hi - lo,
        f => setStatus('rom-status', `Erasing ROMs… ${Math.round(100 * (done + f * (hi - lo)) / total)}%`));
      done += hi - lo;
    }
    gs2kOk = false;
    gs2kRetry = gs2kAllHeld();
    setStatus('rom-status', 'All ROMs erased.', 'ok');
  } catch (err) {
    if (picoboot)      // an unplug is already reported by the disconnect handler
      setStatus('rom-status', 'Erase failed: ' + err.message +
        ' — the ROM area may be partly erased; upload the ROMs again.', 'err');
  } finally {
    linkBusy = false;
  }
  if (!picoboot) return;
  await verifyAll();               // re-reads the board: every persona "ROMs missing"
  setUploadsEnabled(true);
});

// ROM pack: every file in a zip (one nested zip deep) whose size equals a
// reference ROM's is hashed; SHA-1 matches are uploaded through the same
// per-file path as the Upload… buttons, in page order, after a dialog that
// lists what was found, what is already on the board and what is missing.
$('btn-zip').addEventListener('click', () => {
  if (!picoboot || linkBusy) return;
  $('zip-file').value = '';
  $('zip-file').click();
});
$('zip-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (linkBusy) {
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before uploading ROMs.</p>');
    return;
  }
  if (!picoboot || !manifest) {
    showError('Not connected',
      '<p>The board is not connected (or has no firmware yet — flash ' +
      'firmware first). Nothing was written.</p>');
    return;
  }
  const dotOk = name => (document.querySelector(`[data-dot="${name}"]`)?.className ?? '').includes('ok');
  setUploadsEnabled(false);
  setStatus('rom-status', `Reading ${f.name}…`);
  const matches = new Map();       // reference name → { entry, data }
  const skipped = [];
  let scanned = 0;
  try {
    const files = await zipFiles(new Uint8Array(await f.arrayBuffer()));
    const sizes = new Set(REFERENCE_ROMS.map(r => r.size));
    for (const en of files) {
      if (en.skip) { skipped.push(`${en.name} (${en.skip})`); continue; }
      if (!sizes.has(en.size)) continue;
      let data;
      try { data = await en.data(); } catch (err) { skipped.push(`${en.name} (${err.message})`); continue; }
      if (data.length !== en.size) continue;
      scanned++;
      setStatus('rom-status', `Reading ${f.name}… ${scanned} candidate file(s) hashed`);
      const h = await sha1hex(data);
      for (const r of REFERENCE_ROMS)
        if (r.sha1 === h && !matches.has(r.name)) matches.set(r.name, { entry: en.name, data });
    }
  } catch (err) {
    setStatus('rom-status', '');
    setUploadsEnabled(true);
    showError('Could not read the zip', `<p><b>${escHtml(f.name)}</b>: ${escHtml(err.message)}</p>`);
    return;
  }

  // Review: per persona, what the zip supplies, what is already verified on
  // the board (not rewritten) and what is still missing.
  const todo = [];
  let rows = '';
  for (const p of PERSONAS) {
    const refs = REFERENCE_ROMS.filter(r => r.set === p.set);
    const up = refs.filter(r => matches.has(r.name) && !dotOk(r.name));
    const have = refs.filter(r => matches.has(r.name) && dotOk(r.name));
    // MU2000 ROMs added earlier in this tab are not missing: they are held
    // for the combined write (gs2kFiles).
    const earlier = refs.filter(r => !matches.has(r.name) && !dotOk(r.name) && gs2kFiles.has(r.name));
    const miss = refs.filter(r => !matches.has(r.name) && !dotOk(r.name) && !gs2kFiles.has(r.name));
    todo.push(...up.map(r => r.name));
    rows += `<li><b>${p.label}</b>: ` +
      (up.length ? `upload ${up.map(r => r.label).join(', ')}` : '<span class="dim">nothing to upload</span>') +
      (have.length ? `<span class="dim"> · already on the board: ${have.map(r => r.label).join(', ')}</span>` : '') +
      (earlier.length ? `<span class="dim"> · added earlier: ${earlier.map(r => r.label).join(', ')}</span>` : '') +
      (miss.length ? `<span class="dim"> · not in the zip: ${miss.map(r => r.label).join(', ')}</span>` : '') +
      (p.id === GS2K && up.length && miss.length
        ? '<span class="dim"> — the MU2000 ROMs are written together, once all six are here</span>' : '') +
      '</li>';
  }
  const skipNote = skipped.length
    ? `<p class="tag">Skipped: ${skipped.map(escHtml).join('; ')}</p>` : '';
  if (!todo.length) {
    setStatus('rom-status', '');
    setUploadsEnabled(true);
    showError(matches.size ? 'Nothing to upload' : 'No ROMs found in the zip',
      `<p><b>${escHtml(f.name)}</b>: ${matches.size} of ${REFERENCE_ROMS.length} reference ROMs matched` +
      (matches.size ? ', all of them already on the board.' : ' — no file inside has a matching SHA-1.') +
      `</p><ul class="found">${rows}</ul>${skipNote}`);
    return;
  }
  const ok = await confirmDialog(`Upload ${todo.length} ROM${todo.length > 1 ? 's' : ''} from the zip?`,
    `<p><b>${escHtml(f.name)}</b> holds ${matches.size} of the ${REFERENCE_ROMS.length} reference ROMs ` +
    '(matched by SHA-1, file names do not matter).</p>' +
    `<ul class="found">${rows}</ul>${skipNote}`,
    `Upload ${todo.length} ROM${todo.length > 1 ? 's' : ''}`);
  if (!ok) { setStatus('rom-status', 'Cancelled — nothing was written.'); setUploadsEnabled(true); return; }

  batchUpload = true;
  let done = 0, failed = [], held = 0;
  const gsTodo = todo.filter(name => REFERENCE_ROMS.find(x => x.name === name).set === GS2K);
  try {
    for (const name of todo) {
      if (!picoboot) break;
      const r = REFERENCE_ROMS.find(x => x.name === name);
      const p = PERSONAS.find(pp => pp.set === r.set);
      const m = matches.get(name);
      // MU2000: matched by SHA-1 above; held here and written together below
      if (r.set === GS2K) { holdGs2k(name, m.data); continue; }
      setStatus('rom-status', `Uploading ${done + failed.length + 1}/${todo.length - gsTodo.length}: ${p.label} ${r.label}…`);
      await uploadRom(name, new File([m.data], `${f.name}/${m.entry}`));
      if (dotOk(name)) done++; else failed.push(`${p.label} ${r.label}`);
    }
    if (gsTodo.length && picoboot) {
      if (!gs2kAllHeld()) held = gsTodo.length;
      else {
        setStatus('rom-status', 'Writing the MU2000 ROMs…');
        await writeGs2k();
        if (gs2kOk) done += gsTodo.length; else failed.push('MU2000');
      }
    }
  } finally {
    batchUpload = false;
    setUploadsEnabled(true);
  }
  if (!picoboot) return;
  // MU2000 ROMs held until the set is complete: say what is still needed
  const heldNote = held
    ? `${held} MU2000 ROM${held > 1 ? 's' : ''}${done || failed.length ? '' : ` from ${f.name}`} ` +
      'kept in this browser tab — still needed: ' +
      gs2kRoms().filter(r => !gs2kFiles.has(r.name)).map(r => r.label).join(', ') + '.'
    : '';
  if (failed.length)
    setStatus('rom-status', `${done}/${todo.length - held} ROMs uploaded from ${f.name}; failed: ` +
      `${failed.join(', ')}.${heldNote ? ' ' + heldNote : ''}`, 'err');
  else if (!done && held)
    setStatus('rom-status', heldNote);
  else
    setStatus('rom-status', `${done} ROM${done !== 1 ? 's' : ''} uploaded from ${f.name}.` +
      (heldNote ? ' ' + heldNote : ''), 'ok');
});

// Modal yes/no; resolves true only on the confirming button (Esc = cancel).
function confirmDialog(title, html, okLabel) {
  const dlg = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-msg').innerHTML = html;
  $('confirm-ok').textContent = okLabel;
  return new Promise(res => {
    dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// The refusal for a file that is not the reference dump (size or SHA-1).
async function refuseFile(file, r, p, data) {
  showError('File not accepted',
    `<p><b>${escHtml(file.name)}</b> is not the supported ${r.label} ` +
    `dump for ${p.label}. The board's boot-time integrity check is ` +
    `keyed to the reference dump, so a different one would fail to ` +
    `boot. Nothing was written.</p>` +
    `<span class="mono">expected: ${r.size.toLocaleString()} bytes, ` +
    `SHA-1 ${r.sha1}</span>` +
    `<span class="mono">got: &nbsp;&nbsp;&nbsp;&nbsp; ` +
    `${data.length.toLocaleString()} bytes, SHA-1 ${await sha1hex(data)}</span>`);
}

async function uploadRom(name, file) {
  const r = REFERENCE_ROMS.find(x => x.name === name);
  const p = PERSONAS.find(pp => pp.set === r.set);
  if (p.id === GS2K) return acceptGs2k(r, p, file);
  const el = document.querySelector(`[data-persona-status="${p.id}"]`);
  const dot = document.querySelector(`[data-dot="${name}"]`);
  const say = msg => { el.textContent = msg; el.className = 'mono pstatus'; };
  if (linkBusy) {     // an operation started while the file picker was open
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before uploading a ROM.</p>');
    return;
  }
  const rec = personaRecord(p.id);
  if (!picoboot || !rec) {
    showError('Not connected',
      '<p>The board is not connected (or has no firmware yet — flash ' +
      'firmware first). Nothing was written.</p>');
    return;
  }

  setUploadsEnabled(false);
  linkBusy = true;
  const prevDot = dot.className;
  let touched = false;         // true once erase begins: flash is modified
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length !== r.size || await sha1hex(data) !== r.sha1) {
      await refuseFile(file, r, p, data);
      return;
    }
    dot.className = 'dot busy';
    await new Promise(res => setTimeout(res));   // paint the spinner

    // Derive the on-board bytes and write each backing flash range — in
    // whichever flash half it lies (eraseFlash / writeFlash route it).
    const plan = filePlan(p.id, rec)[name];
    const derived = applyXformFwd(plan.xform, data);
    const total = plan.parts.reduce((a, pt) => a + pt.len, 0);
    let src = 0, done = 0;
    for (const pt of plan.parts) {
      const im = rec.images.find(im => im.hwAddr === pt.hw);
      if (!im || pt.off + pt.len > im.bytes)
        throw new Error('the installed firmware has no place for this ROM');
      const off = im.flashOff + pt.off;
      const part = derived.subarray(src, src + pt.len);
      src += pt.len;
      say('checking…');
      if (await partInPlace(im, pt, part)) { done += pt.len; continue; }
      // Block erase through a stub (stubs.js), 256K per EXEC so each ack
      // stays well under its timeout; file extents are 4K-aligned and never
      // share sectors.
      touched = true;
      say(`erasing… ${Math.round(100 * done / total)}%`);
      await eraseFlash(off, pt.len,
        f => say(`erasing… ${Math.round(100 * (done + f * pt.len) / total)}%`));
      await writeFlash(off, part,
        f => say(`writing… ${Math.round(100 * (done + f * pt.len) / total)}%`));
      done += pt.len;
    }

    // Verify the way the connect-time check does: the board's own push hash
    // of the whole persona against the manifest's RLPH entry (every file of
    // the persona must be in place for it to match); only a mismatch or a
    // table-less image pays for the file read-back, which pinpoints.
    say('verifying…');
    let good = false, viaHash = false;
    const expect = expectedHash(rec);
    // The whole-persona hash can only match once every file is in place;
    // with any still blank, go straight to this file's read-back (one
    // "verifying" pass, not a doomed hash followed by the read-back).
    if (expect !== null && expect !== 0n && await blankFiles(p.id, rec) === 0) {
      try {
        good = (await hashImages(pushedImages(rec),
          f => say(`verifying… ${Math.round(100 * f)}%`))) === expect;
        viaHash = good;        // only a MATCH proves the other files; a
                               // read-back below verifies this file alone
      } catch (e) { console.warn(`hash stub: ${e.message}; reading back instead`); }
    }
    if (!good)
      good = (await readAndCheckFile(rec, r, plan,
        f => say(`verifying… ${Math.round(100 * f)}%`))) === true;
    if (good && viaHash)               // the whole persona verified at once
      REFERENCE_ROMS.filter(x => x.set === p.set).forEach(x =>
        { const d = document.querySelector(`[data-dot="${x.name}"]`); if (d) d.className = 'dot ok'; });
    dot.className = 'dot ' + (good ? 'ok' : 'err');
    say('');
    if (!good)
      showError('Verification failed',
        '<p>The ROM was written, but reading it back did not reproduce the ' +
        'file. Try the upload again.</p>');
  } catch (err) {
    dot.className = touched ? 'dot err' : prevDot;
    say('');
    if (picoboot)      // an unplug is already reported by the disconnect handler
      showError('Upload failed',
        `<p>${escHtml(err.message)}</p>` +
        (touched ? '<p>The ROM’s flash area may be partially written — ' +
                   'upload it again before rebooting the board.</p>' : ''));
  } finally {
    linkBusy = false;
    setUploadsEnabled(true);
  }
}

// ---- MU2000 (persona gs2k): collect, combine, write, verify -----------------
// (state and the why: next to SHARED_HALF above)
const roundUpSector = n => Math.ceil(n / SECTOR) * SECTOR;

// The record's two kinds of image: the one pushed image (the samples) and
// the control tables the firmware reads in place.
function gs2kImages(rec) {
  const pushed = rec ? pushedImages(rec) : [];
  return { samples: pushed.length === 1 ? pushed[0] : null,
           ctl: rec?.images.find(im => im.hwAddr === FW_TABLE_HW) ?? null };
}

// Dots: green when the persona verifies, a ring for a ROM added in this tab
// but not on the board yet, red otherwise; state 'busy' spins all six.
function showGs2kDots(state) {
  for (const r of gs2kRoms()) {
    const d = document.querySelector(`[data-dot="${r.name}"]`);
    if (!d) continue;
    const held = state !== 'ok' && state !== 'busy' && gs2kFiles.has(r.name);
    d.className = 'dot ' + (state === 'ok' || state === 'busy' ? state : held ? 'held' : 'err');
    d.title = held ? 'Added — kept in this browser tab and written together with the ' +
                     'others once all six MU2000 ROMs are here.' : '';
  }
  renderGs2kNote();
}

// The line under the MU2000 card: what is still needed, or the button that
// writes a complete set that is not on the board (after an erase, or after
// a write that did not verify).
function renderGs2kNote() {
  const el = document.querySelector(`[data-persona-note="${GS2K}"]`);
  if (!el) return;
  const roms = gs2kRoms(), need = roms.filter(r => !gs2kFiles.has(r.name));
  let html = '';
  if (gs2kOk) html = '';
  else if (!need.length)
    html = gs2kRetry && uploadsOn
      ? 'All six ROMs are here, kept in this browser tab. <button data-gs2k-write>Write to board</button>'
      : '';                        // the automatic write is starting or running
  else if (need.length === roms.length)
    html = 'The six MU2000 ROMs are combined on this page and written to the board ' +
           'together, once all six are here.';
  else
    html = `${roms.length - need.length} of ${roms.length} ROMs added — still needed: ` +
           `${need.map(r => r.label).join(', ')}. The ones added so far are kept in ` +
           'this browser tab; all six are written together.';
  el.innerHTML = html;
}

function holdGs2k(name, data) {
  gs2kFiles.set(name, data);
  showGs2kDots(gs2kOk ? 'ok' : null);
}

// The control tables' expected CRC-32 and length (RLFT), or null on an image
// without the table.
function gs2kCtlExpect() {
  const idx = manifest ? manifest.personas.findIndex(p => p.name === GS2K) : -1;
  const e = idx >= 0 && fwTables ? fwTables[idx] : null;
  return e && e.bytes ? e : null;
}
// The control tables in place: their CRC-32 and length against RLFT (and
// `built`, the bytes built in this tab, must agree with it); on an image
// without RLFT, byte-equal to `built` when given, else non-blank and
// starting with the magic.
async function gs2kCtlInPlace(im, built = gs2kCtl, progress) {
  const exp = gs2kCtlExpect();
  if (exp) {
    // read back exactly the expected length and check its CRC: proves the
    // tables in place whether or not this page built them
    if (exp.bytes > im.bytes || (built && (built.length !== exp.bytes || crc32(built) !== exp.crc))) return false;
    return crc32(await readFlash(im.flashOff, exp.bytes, progress)) === exp.crc;
  }
  if (built) {
    if (built.length > im.bytes) return false;
    const back = await readFlash(im.flashOff, built.length, progress);
    for (let i = 0; i < built.length; i++) if (back[i] !== built[i]) return false;
    return true;
  }
  const head = await readFlash(im.flashOff, 256);
  return GS2K_MAGIC.every((c, i) => head[i] === c);
}

// Connect-time check (from verifyPersona). `onFrac` 0..1 as elsewhere.
async function verifyGs2k(rec, onFrac = () => {}) {
  const el = document.querySelector(`[data-persona-status="${GS2K}"]`);
  const show = (text, err = false) => { el.textContent = text; el.className = 'mono pstatus' + (err ? ' err' : ''); };
  const { samples, ctl } = gs2kImages(rec);
  gs2kOk = false;
  if (!samples || !ctl) {
    show('not supported by the installed firmware', true);
    showGs2kDots(null); onFrac(1);
    return;
  }
  const blankS = await regionBlank(samples.flashOff, samples.bytes);
  const blankC = await regionBlank(ctl.flashOff, ctl.bytes);
  if (blankS && blankC) {
    show('ROMs missing — upload below', true);
    showGs2kDots(null); onFrac(1);
    return;
  }
  showGs2kDots('busy'); show('verifying…');
  await new Promise(res => setTimeout(res));
  const expect = expectedHash(rec);
  let good = false;
  if (!blankS && !blankC && expect !== null && expect !== 0n) {
    try {
      good = await hashImages([samples], f => {
        show(`verifying… ${Math.round(100 * f)}%`);
        onFrac(f * samples.bytes / (samples.bytes + ctl.bytes));
      }) === expect;
    } catch (e) { console.warn(`hash stub (${GS2K}): ${e.message}`); }
    if (good) good = await gs2kCtlInPlace(ctl);
  }
  gs2kOk = good;
  gs2kRetry = !good && gs2kAllHeld();
  showGs2kDots(good ? 'ok' : null);
  show(good ? '' : blankS || blankC ? 'incomplete — upload below' : 'not verified — upload below', !good);
  onFrac(1);
}

// A file from an Upload… button: checked like every ROM, then held; the
// sixth one starts the write.
async function acceptGs2k(r, p, file) {
  if (linkBusy) {     // an operation started while the file picker was open
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before uploading a ROM.</p>');
    return;
  }
  if (!picoboot) {
    showError('Not connected', '<p>The board is not connected. Nothing was written.</p>');
    return;
  }
  const { samples, ctl } = gs2kImages(personaRecord(GS2K));
  if (!samples || !ctl) {
    showError('MU2000 not supported yet',
      '<p>The firmware installed on this board has no MU2000. Flash a newer ' +
      'firmware release first, then upload the MU2000 ROMs. Nothing was written.</p>');
    return;
  }
  setUploadsEnabled(false);
  let data;
  try {
    data = new Uint8Array(await file.arrayBuffer());
    if (data.length !== r.size || await sha1hex(data) !== r.sha1) {
      await refuseFile(file, r, p, data);
      return;
    }
  } finally {
    setUploadsEnabled(true);
  }
  holdGs2k(r.name, data);
  if (gs2kAllHeld()) await writeGs2k();
}

// True when the board's push hash over `im` equals `want`; any doubt (blank,
// stub error) = no.
async function hashInPlace(im, want, progress) {
  if (await regionBlank(im.flashOff, im.bytes)) return false;
  try { return await hashImages([im], progress) === want; }
  catch (e) { console.warn(`hash stub: ${e.message}; writing it`); return false; }
}

// All six held: build the pack, write what differs, verify the persona.
// The samples go to the pushed image (upper half: flash4 stub), skipped when
// the board's push hash of them already matches; the control tables go to
// the in-place image (lower half), skipped when they read back identical.
async function writeGs2k() {
  if (!picoboot || !gs2kAllHeld()) return;
  if (linkBusy) {
    showError('Board busy',
      '<p>A read or write operation is in progress — wait for it to ' +
      'finish before writing the MU2000 ROMs.</p>');
    return;
  }
  const el = document.querySelector(`[data-persona-status="${GS2K}"]`);
  const say = (msg, cls = '') => { el.textContent = msg; el.className = 'mono pstatus' + (cls ? ' ' + cls : ''); };
  const pct = f => Math.round(100 * f);
  const rec = personaRecord(GS2K);
  const { samples: sIm, ctl: cIm } = gs2kImages(rec);
  if (!sIm || !cIm) return;
  const was = { ok: gs2kOk, text: el.textContent, cls: el.className };
  setUploadsEnabled(false);
  linkBusy = true;
  gs2kOk = false;
  gs2kRetry = false;
  showGs2kDots('busy');
  let touched = false;           // true once an erase begins
  let refused = false;           // the pre-check said this firmware expects other data: a retry cannot help
  try {
    say('converting…');
    await new Promise(res => setTimeout(res));   // paint before the converter holds the thread
    const pack = await buildGs2kPack(Object.fromEntries(gs2kFiles));
    // The board's layout and its expected hash were made for one converter
    // output; a different one (an older firmware, a newer page) is refused
    // before anything is erased.
    const want = pushHash([{ hwAddr: sIm.hwAddr, data: pack.samples }]);
    const expect = expectedHash(rec);
    const target = expect !== null && expect !== 0n ? expect : want;
    const cexp = gs2kCtlExpect();
    if (pack.samples.length !== sIm.bytes || pack.ctl.length > cIm.bytes || want !== target ||
        (cexp && (pack.ctl.length !== cexp.bytes || crc32(pack.ctl) !== cexp.crc))) {
      refused = true;
      throw new Error('The converted MU2000 data does not match what the firmware on ' +
                      'this board expects. Update the firmware, then try again. Nothing was written.');
    }

    say('checking…');
    if (!await hashInPlace(sIm, want, f => say(`checking… ${pct(f)}%`))) {
      touched = true;
      await eraseFlash(sIm.flashOff, roundUpSector(sIm.bytes), f => say(`erasing… ${pct(f)}%`));
      await writeFlash(sIm.flashOff, pack.samples, f => say(`writing… ${pct(f)}%`));
    }
    if (!await gs2kCtlInPlace(cIm, pack.ctl)) {
      touched = true;
      say('writing…');
      await eraseFlash(cIm.flashOff, roundUpSector(cIm.bytes));
      await writeFlash(cIm.flashOff, pack.ctl);
    }
    gs2kCtl = pack.ctl;          // what the board holds now: the connect-time check compares with it

    say('verifying…');
    let good = false;
    try {
      good = await hashImages([sIm], f => say(`verifying… ${pct(f)}%`)) === target;
    } catch (e) { console.warn(`hash stub (${GS2K}): ${e.message}`); }
    if (good) good = await gs2kCtlInPlace(cIm, pack.ctl);
    gs2kOk = good;
    gs2kRetry = !good;
    showGs2kDots(good ? 'ok' : null);
    say(good ? '' : 'not verified — write again', good ? '' : 'err');
    if (!good)
      showError('Verification failed',
        '<p>The MU2000 data was written, but reading it back did not match. ' +
        'Write it again with the button on the MU2000 card.</p>');
  } catch (err) {
    gs2kRetry = !refused;
    if (touched) { gs2kOk = false; showGs2kDots(null); say('not verified — write again', 'err'); }
    else { gs2kOk = was.ok; if (was.ok) gs2kRetry = false; showGs2kDots(was.ok ? 'ok' : null); el.textContent = was.text; el.className = was.cls; }
    if (picoboot)      // an unplug is already reported by the disconnect handler
      showError('Upload failed',
        `<p>${escHtml(err.message)}</p>` +
        (touched ? '<p>The MU2000 data on the board may be partly written — write it ' +
                   'again before rebooting the board.</p>' : ''));
  } finally {
    linkBusy = false;
    setUploadsEnabled(true);
    renderGs2kNote();
  }
}
