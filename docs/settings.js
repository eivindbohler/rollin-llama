// Persistent card settings — the firmware's settings sector (fw/rp2040/core/
// settings.c), one record at the start of its own 4 KB sector.
// Version 2 (24 bytes):
//   u32 magic "RLST" | u32 version (2) | u32 flags | char last_persona[8] |
//   u8 volume (0..127) | u8 pad | u16 CRC-16/CCITT-FALSE over bytes 0..21
// Version 1 (22 bytes, no volume; CRC over bytes 0..19 at offset 20) is
// still read — it means volume 127 — and is rewritten as version 2 on save.
// A blank or unparsable sector means defaults (extra interfaces OFF, no
// remembered persona, volume 127).
export const SETTINGS_OFF = 0x021000;
export const SETTINGS_MAGIC = 0x54534c52;
export const SETTINGS_VERSION = 2;
export const FLAG_USB_VENDOR = 1 << 0;   // audio-capture (vendor) interface
export const FLAG_USB_AUDIO  = 1 << 1;   // USB audio (UAC2) interface
// bit 2 reserved
export const DEFAULT_FLAGS = 0;          // blank sector: MIDI only
export const VOLUME_MAX = 127;           // 0 dB; 0.5 dB per step; 0 = mute
export const DEFAULT_VOLUME = VOLUME_MAX;
export const RECORD_LEN = 24;            // v2; a v1 record is 22 and fits

function crc16(bytes, n) {
  let c = 0xffff;
  for (let i = 0; i < n; i++) {
    c ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++)
      c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

export function decodeSettings(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = { flags: DEFAULT_FLAGS, lastPersona: '', volume: DEFAULT_VOLUME, valid: false };
  if (bytes.length < RECORD_LEN || v.getUint32(0, true) !== SETTINGS_MAGIC) return bad;
  const ver = v.getUint32(4, true);
  let volume;
  if (ver === 1) {
    if (v.getUint16(20, true) !== crc16(bytes, 20)) return bad;
    volume = DEFAULT_VOLUME;
  } else if (ver === SETTINGS_VERSION) {
    if (v.getUint16(22, true) !== crc16(bytes, 22)) return bad;
    volume = Math.min(bytes[20], VOLUME_MAX);
  } else
    return bad;
  const name = bytes.subarray(12, 20);
  const end = name.indexOf(0);
  return {
    flags: v.getUint32(8, true),
    lastPersona: new TextDecoder().decode(name.subarray(0, end < 0 ? 8 : end)),
    volume,
    valid: true,
  };
}

export function encodeSettings(s) {
  const out = new Uint8Array(RECORD_LEN);
  const v = new DataView(out.buffer);
  v.setUint32(0, SETTINGS_MAGIC, true);
  v.setUint32(4, SETTINGS_VERSION, true);
  v.setUint32(8, s.flags >>> 0, true);
  out.set(new TextEncoder().encode(s.lastPersona || '').subarray(0, 7), 12);
  out[20] = Math.min(Math.max(s.volume ?? DEFAULT_VOLUME, 0), VOLUME_MAX);
  out[21] = 0;
  v.setUint16(22, crc16(out, 22), true);
  return out;
}
