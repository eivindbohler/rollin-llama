// Rollin' Llama web flasher — connection state machine.
//
// Normal mode: the board is a USB-MIDI device ("Rollin' Llama"). The live-mode
// operations are the BOOTSEL doorbell SysEx (F0 7D 52 4C 02 F7) and the
// volume SysEx (F0 7D 52 4C 03 vv F7); everything else — version read,
// firmware flash, ROM writes, settings — happens over PICOBOOT (WebUSB) once
// the board re-enumerates as RPI-RP2.
import { REFERENCE_ROMS, PERSONAS, sha1hex } from './roms.js';
import { parseManifest, parsePushTable, pushHash,
         MANIFEST_OFF, PUSH_TBL_OFF } from './manifest.js';
import { filePlan, applyXform, applyXformFwd } from './transforms.js';
import { openPicoboot, parseUf2, flashUf2, ClaimBlockedError,
         FLASH_BASE, SECTOR, PAGE } from './picoboot.js';
import { SETTINGS_OFF, RECORD_LEN, FLAG_USB_VENDOR, FLAG_USB_AUDIO,
         VOLUME_MAX, decodeSettings, encodeSettings } from './settings.js';

const VER_BLK_OFF = 0x020300;      // RLVR: magic + fmt + ver[32] git[24] date[16]
const VER_BLK_MAGIC = 0x52564c52;

const RPI_VID = 0x2e8a, RPI_BOOT_PID = 0x0003;
const DOORBELL = [0xF0, 0x7D, 0x52, 0x4C, 0x02, 0xF7];
const VOLUME_SYX = v => [0xF0, 0x7D, 0x52, 0x4C, 0x03, v & 0x7F, 0xF7];
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
async function midiOut(statusId) {
  if (!midiAccess) {
    setStatus(statusId,
      'Requesting MIDI access — if nothing happens, look for a permission ' +
      'icon at the right end of the address bar.');
    midiAccess = await Promise.race([
      navigator.requestMIDIAccess({ sysex: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        'no response from the permission prompt. Check the address-bar icon, ' +
        'or allow MIDI for this site under chrome://settings/content/midiDevices'
      )), 15000)),
    ]);
  }
  return [...midiAccess.outputs.values()]
    .find(o => o.name && o.name.includes(MIDI_NAME)) || null;
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
    setStatus('connect-status', 'Connected (BOOTSEL / PICOBOOT).', 'ok');
    $('btn-connect').disabled = true;
    $('btn-bootsel').textContent = 'Put board in MIDI mode';
    $('btn-bootsel').disabled = false;
    $('firmware').classList.remove('hidden');
    $('roms').classList.remove('hidden');
    $('settings').classList.remove('hidden');
    $('volume').classList.add('hidden');      // live control: MIDI mode only
    setStatus('fw-status', '');
    setStatus('rom-status', '');
    setStatus('settings-status', '');
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
  $('fw-progress').classList.add('hidden');
  verifyBar.hide();
  $('btn-flash-fw').disabled = false;
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
async function showVersion() {
  try {
    const dv = await picoboot.read(FLASH_BASE + VER_BLK_OFF, 80);
    if (dv.getUint32(0, true) !== VER_BLK_MAGIC) {
      $('fw-version').textContent = 'none (blank or pre-release image)';
      return;
    }
    const str = (off, len) => {
      const b = new Uint8Array(dv.buffer, dv.byteOffset + off, len);
      const end = b.indexOf(0);
      return new TextDecoder().decode(b.subarray(0, end < 0 ? len : end));
    };
    const ver = str(8, 32), git = str(40, 24), date = str(64, 16);
    $('fw-version').textContent =
      `${ver || 'unknown'}${git ? ' (' + git + ')' : ''}${date ? ' · ' + date : ''}`;
  } catch (e) {
    $('fw-version').textContent = 'read failed: ' + e.message;
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
                ($('set-audio').checked ? FLAG_USB_AUDIO : 0);
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
// 128 steps of 0.5 dB, 127 = 0 dB, 0 = mute; the board ramps between values
// and persists the last one itself (idle auto-save), so nothing is written
// from here. The current value cannot be read back over MIDI, so the slider
// starts at the last value set from this browser, else full.
function volumeLabel(v) {
  return v === 0 ? '0 · mute' : `${v} · ${(-0.5 * (VOLUME_MAX - v)).toFixed(1)} dB`;
}
{
  const slider = $('vol-slider');
  let last = null;
  try { last = localStorage.getItem('volume'); } catch (e) { /* private mode */ }
  if (last !== null && !isNaN(+last)) slider.value = Math.min(Math.max(+last, 0), VOLUME_MAX);
  const show = () => { $('vol-value').textContent = volumeLabel(+slider.value); };
  slider.addEventListener('input', show);
  show();
}
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
    out.send(VOLUME_SYX(v));
    try { localStorage.setItem('volume', String(v)); } catch (e) { /* private mode */ }
    setStatus('volume-status',
      `Volume ${volumeLabel(v)} sent — the board stores it after a few idle seconds.`, 'ok');
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
    setStatus('fw-status',
      `${f.name}: ${ranges.length} region(s), ${total.toLocaleString()} flash bytes`);
    bar.classList.remove('hidden');
    $('btn-flash-fw').disabled = true;
    linkBusy = true;
    await flashUf2(picoboot, ranges, (frac, label) => {
      bar.value = Math.round(frac * 100);
      setStatus('fw-status', `${label}… ${Math.round(frac * 100)}%`);
    });
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

// ---- ROM section ------------------------------------------------------------
let manifest = null, pushTable = null;

async function readFlash(addr, size, progress) {
  const out = new Uint8Array(size);
  const CHUNK = 4096;
  for (let o = 0; o < size; o += CHUNK) {
    const n = Math.min(CHUNK, size - o);
    const dv = await picoboot.read(FLASH_BASE + addr + o, n);
    out.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), o);
    if (progress) progress((o + n) / size);
  }
  return out;
}

function personaRecord(id) {
  return manifest?.personas.find(pr => pr.name === id);
}

async function renderRomTable() {
  const list = $('rom-list');
  list.innerHTML = '';
  try {
    const mdv = await picoboot.read(FLASH_BASE + MANIFEST_OFF, 512);
    manifest = parseManifest(mdv);
    const pdv = await picoboot.read(FLASH_BASE + PUSH_TBL_OFF, 64);
    pushTable = parsePushTable(pdv);
  } catch (e) {
    setStatus('rom-status', 'manifest read failed: ' + e.message, 'err');
  }

  for (const p of PERSONAS) {
    const card = document.createElement('div');
    card.className = 'subcard';
    let rows = '<tr><th>ROM</th><th style="text-align:right">Size</th>' +
               '<th>Reference SHA-1</th><th></th></tr>';
    for (const r of REFERENCE_ROMS.filter(r => r.set === p.set)) {
      rows +=
        `<tr><td><span class="dot" data-dot="${r.name}"></span>${r.label}</td>` +
        `<td class="mono">${r.size.toLocaleString()}</td>` +
        `<td class="mono">${r.sha1}</td>` +
        `<td><button data-upload="${r.name}" disabled>Upload…</button></td></tr>`;
    }
    card.innerHTML =
      `<div class="phead"><b>${p.label} <span class="pver">(${p.version})</span></b>` +
      `<span class="mono pstatus" data-persona-status="${p.id}">checking…</span></div>` +
      `<table>${rows}</table>`;
    list.appendChild(card);
  }
  list.onclick = onRomListClick;
  await verifyAll();
  setUploadsEnabled(true);
}

// Only one PICOBOOT conversation at a time: the upload buttons stay disabled
// while the verify cascade or another upload holds the link.
function setUploadsEnabled(on) {
  document.querySelectorAll('button[data-upload]')
    .forEach(b => b.disabled = !on);
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

// `onFrac` reports 0..1 of this persona's read-back (1 when skipped).
async function verifyPersona(id, onFrac = () => {}) {
  const el = document.querySelector(`[data-persona-status="${id}"]`);
  const dot = name => document.querySelector(`[data-dot="${name}"]`);
  const p = PERSONAS.find(p => p.id === id);
  const files = REFERENCE_ROMS.filter(r => r.set === p.set);
  const rec = personaRecord(id);
  if (!rec || !rec.images.length) {
    el.textContent = 'no manifest entry';
    el.className = 'mono pstatus err';
    files.forEach(r => dot(r.name).className = 'dot err');
    return;
  }
  // Blank probe (start AND middle of each extent — real ROMs can begin with
  // FF runs, an erased slot is FF everywhere).
  for (const im of rec.images) {
    const p0 = await readFlash(im.flashOff, 256);
    const p1 = await readFlash((im.flashOff + (im.bytes >> 1)) & ~0xff, 256);
    if (p0.every(b => b === 0xff) && p1.every(b => b === 0xff)) {
      el.textContent = 'ROMs missing — upload below';
      el.className = 'mono pstatus err';
      files.forEach(r => dot(r.name).className = 'dot err');
      return;
    }
  }
  // File-granular verification, strictly in page order: each ROM's own
  // backing byte ranges are read (files partition the images, so every byte
  // is still read exactly once), reconstructed and hashed — one spinner at
  // a time, one flip per ROM.
  const plan = filePlan(id);
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
    dot(r.name).className = 'dot ' + (good ? 'ok' : 'err');
    if (good) ok++;
  }
  const all = ok === files.length;
  el.textContent = all ? '' : `${ok}/${files.length} verified`;
  el.className = 'mono pstatus ' + (all ? '' : 'err');
}

// Read one ROM's backing flash ranges, reconstruct the original file bytes
// via the inverse transform, and check size + SHA-1. `onFrac` gets 0..1 of
// this file's read progress.
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
  return data.length === r.size && await sha1hex(data) === r.sha1;
}

// ---- upload flow ------------------------------------------------------------
// The push-hash table (RLPH) baked into the manifest describes the reference
// dumps; a different dump would fail the boot-time push check (red LED). So
// unlike the dev-repo tools, this flasher REFUSES non-reference files.
let pendingUpload = null;

function onRomListClick(e) {
  const name = e.target.dataset?.upload;
  if (!name || !picoboot) return;
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

async function uploadRom(name, file) {
  const r = REFERENCE_ROMS.find(x => x.name === name);
  const p = PERSONAS.find(pp => pp.set === r.set);
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
      '<p>The board is not connected (or has no manifest yet — flash ' +
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
      showError('File not accepted',
        `<p><b>${escHtml(file.name)}</b> is not the supported ${r.label} ` +
        `dump for ${p.label}. The board's boot-time integrity check is ` +
        `keyed to the reference dump, so a different one would fail to ` +
        `boot. Nothing was written.</p>` +
        `<span class="mono">expected: ${r.size.toLocaleString()} bytes, ` +
        `SHA-1 ${r.sha1}</span>` +
        `<span class="mono">got: &nbsp;&nbsp;&nbsp;&nbsp; ` +
        `${data.length.toLocaleString()} bytes, SHA-1 ${await sha1hex(data)}</span>`);
      return;
    }
    dot.className = 'dot busy';
    await new Promise(res => setTimeout(res));   // paint the spinner

    // Derive the on-board bytes and write each backing flash range.
    const plan = filePlan(p.id)[name];
    const derived = applyXformFwd(plan.xform, data);
    const total = plan.parts.reduce((a, pt) => a + pt.len, 0);
    let src = 0, done = 0;
    for (const pt of plan.parts) {
      const im = rec.images.find(im => im.hwAddr === pt.hw);
      if (!im || pt.off + pt.len > im.bytes)
        throw new Error('manifest does not cover this ROM');
      const base = FLASH_BASE + im.flashOff + pt.off;
      const part = derived.subarray(src, src + pt.len);
      src += pt.len;
      // Erase in 256K chunks so each PICOBOOT ack stays well under its
      // timeout; file extents are 4K-aligned and never share sectors.
      touched = true;
      for (let o = 0; o < pt.len; o += 0x40000) {
        say(`erasing… ${Math.round(100 * (done + o) / total)}%`);
        await picoboot.erase(base + o, Math.min(0x40000, pt.len - o));
      }
      for (let o = 0; o < pt.len; o += 4096) {
        await picoboot.write(base + o, part.subarray(o, Math.min(o + 4096, pt.len)));
        say(`writing… ${Math.round(100 * (done + o + 4096) / total)}%`);
      }
      done += pt.len;
    }

    // Read back through the same path the verifier uses.
    const good = await readAndCheckFile(rec, r, plan,
      f => say(`verifying… ${Math.round(100 * f)}%`));
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
