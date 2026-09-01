// Persistent card settings — the firmware's settings sector (fw/rp2040/core/
// settings.c), one 22-byte record at the start of its own 4 KB sector:
//   u32 magic "RLST" | u32 version | u32 flags | char last_persona[8] |
//   u16 CRC-16/CCITT-FALSE over bytes 0..19
// A blank or unparsable sector means defaults (extra interfaces OFF, no
// remembered persona).
export const SETTINGS_OFF = 0x021000;
export const SETTINGS_MAGIC = 0x54534c52;
export const SETTINGS_VERSION = 1;
export const FLAG_USB_VENDOR = 1 << 0;   // audio-capture (vendor) interface
export const FLAG_USB_AUDIO  = 1 << 1;   // USB audio (UAC2) interface
// bit 2 reserved
export const DEFAULT_FLAGS = 0;          // blank sector: MIDI only
export const RECORD_LEN = 22;

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
  if (bytes.length < RECORD_LEN ||
      v.getUint32(0, true) !== SETTINGS_MAGIC ||
      v.getUint32(4, true) !== SETTINGS_VERSION ||
      v.getUint16(20, true) !== crc16(bytes, 20))
    return { flags: DEFAULT_FLAGS, lastPersona: '', valid: false };
  const name = bytes.subarray(12, 20);
  const end = name.indexOf(0);
  return {
    flags: v.getUint32(8, true),
    lastPersona: new TextDecoder().decode(name.subarray(0, end < 0 ? 8 : end)),
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
  v.setUint16(20, crc16(out, 20), true);
  return out;
}
