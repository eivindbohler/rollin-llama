// Minimal zip reader for the ROM-pack upload: central directory walk,
// stored or deflated entries, nested .zip files one level down. Inflation
// is the browser's own DecompressionStream('deflate-raw'); nothing third-
// party. Not handled (reported, never guessed at): zip64, encrypted
// entries, other compression methods.
const SIG_EOCD = 0x06054b50, SIG_CDIR = 0x02014b50, SIG_LOCAL = 0x04034b50;

// → [{ name, size, method, flags, data() }], data() resolving to the
// uncompressed bytes; `size` is the central directory's uncompressed size.
export function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
  let eocd = -1;
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 65535); o--)
    if (u32(o) === SIG_EOCD) { eocd = o; break; }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = u16(eocd + 10), cdOff = u32(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 archives are not supported');
  const out = [];
  const dec = new TextDecoder();
  let o = cdOff;
  for (let i = 0; i < count; i++) {
    if (u32(o) !== SIG_CDIR) throw new Error('damaged zip: central directory entry ' + i);
    const flags = u16(o + 8), method = u16(o + 10);
    const csize = u32(o + 20), size = u32(o + 24);
    const nlen = u16(o + 28), xlen = u16(o + 30), clen = u16(o + 32);
    const local = u32(o + 42);
    const name = dec.decode(bytes.subarray(o + 46, o + 46 + nlen));
    o += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;                 // directory
    out.push({
      name, size, method, flags,
      encrypted: (flags & 1) !== 0,
      zip64: size === 0xffffffff || csize === 0xffffffff || local === 0xffffffff,
      async data() {
        if (u32(local) !== SIG_LOCAL) throw new Error('damaged zip: local header of ' + name);
        const start = local + 30 + u16(local + 26) + u16(local + 28);
        const raw = bytes.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`unsupported compression method ${method} in ${name}`);
        const ds = new DecompressionStream('deflate-raw');
        const blob = new Blob([raw]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(blob).arrayBuffer());
      },
    });
  }
  return out;
}

// Flatten: entries of `bytes`, plus those of any .zip inside it (one level),
// named "inner.zip/file". Problem entries carry `skip` with the reason.
export async function zipFiles(bytes, depth = 0) {
  const files = [];
  for (const e of zipEntries(bytes)) {
    if (e.encrypted) { files.push({ ...e, skip: 'encrypted' }); continue; }
    if (e.zip64) { files.push({ ...e, skip: 'zip64' }); continue; }
    if (e.method !== 0 && e.method !== 8) { files.push({ ...e, skip: 'compression method ' + e.method }); continue; }
    if (/\.zip$/i.test(e.name) && depth < 1) {
      try {
        for (const f of await zipFiles(await e.data(), depth + 1))
          files.push({ ...f, name: e.name + '/' + f.name });
      } catch (err) { files.push({ ...e, skip: err.message }); }
      continue;
    }
    files.push(e);
  }
  return files;
}
