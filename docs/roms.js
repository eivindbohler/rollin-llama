// Reference ROM-dump table — mirrors tools/rl_roms.py in the dev repo.
// name → { size, sha1, set }. Keep the two tables in sync.
export const PERSONAS = [
  { id: 'mt32',    label: 'MT-32',     version: 'v1.07',  set: 'mt32' },
  { id: 'cm32l',   label: 'CM-32L',    version: 'v1.02',  set: 'cm32l' },
  { id: 'sc55mk1', label: 'SC-55 mk1', version: 'v1.21',     set: 'sc55-mk1' },
  { id: 'sc55mk2', label: 'SC-55 mk2', version: 'v1.01',     set: 'sc55-mk2' },
];

export const REFERENCE_ROMS = [
  { set: 'mt32',     name: 'MT32_CONTROL.ROM', label: 'Control ROM',     size: 65536,   sha1: 'b083518fffb7f66b03c23b7eb4f868e62dc5a987' },
  { set: 'mt32',     name: 'MT32_PCM.ROM', label: 'PCM ROM',         size: 524288,  sha1: 'f6b1eebc4b2d200ec6d3d21d51325d5b48c60252' },
  { set: 'cm32l',    name: 'CM32L_CONTROL.ROM', label: 'Control ROM',    size: 65536,   sha1: 'a439fbb390da38cada95a7cbb1d6ca199cd66ef8' },
  { set: 'cm32l',    name: 'CM32L_PCM.ROM', label: 'PCM ROM',        size: 1048576, sha1: '289cc298ad532b702461bfc738009d9ebe8025ea' },
  { set: 'sc55-mk1', name: 'sc55mk1_rom1.bin', label: 'ROM 1 (CPU)',     size: 32768,   sha1: 'dd01ec54027751c2f2f2e47bbb7a0bf3d1ca8ae2' },
  { set: 'sc55-mk1', name: 'sc55mk1_rom2.bin', label: 'ROM 2',     size: 262144,  sha1: '9c17f85e784dc1549ac1f98d457b353393331f6b' },
  { set: 'sc55-mk1', name: 'sc55mk1_waverom1.bin', label: 'Wave ROM 1', size: 1048576, sha1: '8cc3c0d7ec0993df81d4ca1970e01a4b0d8d3775' },
  { set: 'sc55-mk1', name: 'sc55mk1_waverom2.bin', label: 'Wave ROM 2', size: 1048576, sha1: '80e6eb130c18c09955551563f78906163c55cc11' },
  { set: 'sc55-mk1', name: 'sc55mk1_waverom3.bin', label: 'Wave ROM 3', size: 1048576, sha1: '7454b817778179806f3f9d1985b3a2ef67ace76f' },
  { set: 'sc55-mk2', name: 'sc55mk2_rom1.bin', label: 'ROM 1 (CPU)',     size: 32768,   sha1: 'b91bb1d9dccffe831b7cfde7800a3fe32b2fbda6' },
  { set: 'sc55-mk2', name: 'sc55mk2_rom_sm.bin', label: 'Sub-MCU ROM',   size: 4096,    sha1: '4d48578d811a762a8e7bfaf18989bcac70ae1ba4' },
  { set: 'sc55-mk2', name: 'sc55mk2_rom2.bin', label: 'ROM 2',     size: 524288,  sha1: '078cb5feea05e80bb9a1bb857a2163ee434fd053' },
  { set: 'sc55-mk2', name: 'sc55mk2_waverom1.bin', label: 'Wave ROM 1', size: 2097152, sha1: '96708cb21381c2fd03de4babbf7aea301c7594a6' },
  { set: 'sc55-mk2', name: 'sc55mk2_waverom2.bin', label: 'Wave ROM 2', size: 1048576, sha1: '4d91cdeaed048d653dbf846a221003c3a3f08279' },
];

export async function sha1hex(buf) {
  const d = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
