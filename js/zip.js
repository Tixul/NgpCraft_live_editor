// Minimal ZIP reader + writer — enough to round-trip the editable `.c`
// files in the project tree. No third-party library.
//
// Writer uses the "stored" method (no compression) so we only need a
// CRC-32; keeps the implementation small and the output trivially
// inspectable. File paths are stored UTF-8 (flag bit 11 set).
//
// Reader walks the End of Central Directory (EOCD) record at the tail
// of the file, then the central directory. Entries stored with method 0
// are read raw; entries stored with method 8 (deflate) are decompressed
// via the browser's native `DecompressionStream('deflate-raw')`. Any
// other method is rejected with a clear error.
//
// Format reference:
//   - PKWARE APPNOTE.TXT §4.3 (local file header, central dir, EOCD)
//   - Signatures: 0x04034b50 (local), 0x02014b50 (central), 0x06054b50 (EOCD)

const NGPC_Zip = (() => {
  // ---- CRC-32 ---------------------------------------------------------
  // Standard CRC-32 with polynomial 0xEDB88320 (reflected 0x04C11DB7).
  // Computed once and cached.
  let crcTable = null;
  function ensureCrcTable() {
    if (crcTable) return;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
  }
  function crc32(bytes) {
    ensureCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = (crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- DOS timestamp (FAT) -------------------------------------------
  // ZIP uses MS-DOS timestamp encoding (2-sec resolution). Close enough
  // for authoring tooling — the editor never depends on the timestamps.
  function dosTimeDate(d = new Date()) {
    const t =
      ((d.getHours()   & 0x1F) << 11) |
      ((d.getMinutes() & 0x3F) << 5)  |
      ((d.getSeconds() >> 1)   & 0x1F);
    const date =
      (((d.getFullYear() - 1980) & 0x7F) << 9) |
      (((d.getMonth() + 1)       & 0x0F) << 5) |
      ((d.getDate()              & 0x1F));
    return { time: t, date };
  }

  // ---- Writer ---------------------------------------------------------
  // `files` is an array of { path, content } where content is a string.
  // Returns a Uint8Array containing the full zip archive.
  function encode(files) {
    const enc = new TextEncoder();
    const { time: dosTime, date: dosDate } = dosTimeDate();

    const locals = [];     // {bytes, offset} per file
    const central = [];    // Uint8Array per file
    let offset = 0;

    for (const { path, content } of files) {
      const name = enc.encode(path);
      const data = enc.encode(content);
      const crc  = crc32(data);
      const size = data.length;

      const header = new Uint8Array(30 + name.length);
      const hv = new DataView(header.buffer);
      hv.setUint32( 0, 0x04034b50, true);   // signature
      hv.setUint16( 4, 20,         true);   // version needed
      hv.setUint16( 6, 0x0800,     true);   // flags (bit 11 = UTF-8 name)
      hv.setUint16( 8, 0,          true);   // stored
      hv.setUint16(10, dosTime,    true);
      hv.setUint16(12, dosDate,    true);
      hv.setUint32(14, crc,        true);
      hv.setUint32(18, size,       true);   // compressed size (= size, stored)
      hv.setUint32(22, size,       true);   // uncompressed size
      hv.setUint16(26, name.length, true);  // file name length
      hv.setUint16(28, 0,          true);   // extra length
      header.set(name, 30);

      const file = new Uint8Array(header.length + data.length);
      file.set(header, 0);
      file.set(data, header.length);
      locals.push({ bytes: file, offset });

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32( 0, 0x02014b50, true);   // signature
      cv.setUint16( 4, 20,         true);   // version made by
      cv.setUint16( 6, 20,         true);   // version needed
      cv.setUint16( 8, 0x0800,     true);   // flags
      cv.setUint16(10, 0,          true);   // stored
      cv.setUint16(12, dosTime,    true);
      cv.setUint16(14, dosDate,    true);
      cv.setUint32(16, crc,        true);
      cv.setUint32(20, size,       true);
      cv.setUint32(24, size,       true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0,          true);   // extra len
      cv.setUint16(32, 0,          true);   // comment len
      cv.setUint16(34, 0,          true);   // disk number
      cv.setUint16(36, 0,          true);   // internal attrs
      cv.setUint32(38, 0,          true);   // external attrs
      cv.setUint32(42, offset,     true);   // local header offset
      cd.set(name, 46);
      central.push(cd);

      offset += file.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const c of central) cdSize += c.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32( 0, 0x06054b50, true);
    ev.setUint16( 4, 0,          true);   // this disk
    ev.setUint16( 6, 0,          true);   // disk w/ CD
    ev.setUint16( 8, files.length, true); // entries on disk
    ev.setUint16(10, files.length, true); // total entries
    ev.setUint32(12, cdSize,     true);
    ev.setUint32(16, cdOffset,   true);
    ev.setUint16(20, 0,          true);   // comment length

    const total = cdOffset + cdSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const l of locals) { out.set(l.bytes, p); p += l.bytes.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
  }

  // ---- Reader ---------------------------------------------------------
  // Accepts a Uint8Array. Returns a Promise<[{ path, content }]> where
  // content is the UTF-8 decoded string. Deflate entries decompress via
  // the browser-native DecompressionStream.
  async function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('ZIP decode expects a Uint8Array.');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Find EOCD: scan backwards from the last possible position. The EOCD
    // can carry up to a 0xFFFF-byte trailing comment, so give ourselves
    // that much slack but bail early at file start.
    let eocd = -1;
    const maxScan = Math.min(bytes.length, 22 + 0xFFFF);
    for (let i = bytes.length - 22; i >= bytes.length - maxScan; i--) {
      if (i < 0) break;
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file (End of Central Directory record not found).');

    const totEntries = dv.getUint16(eocd + 10, true);
    const cdOffset   = dv.getUint32(eocd + 16, true);

    const dec = new TextDecoder();
    const out = [];
    let p = cdOffset;
    for (let i = 0; i < totEntries; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) {
        throw new Error(`Corrupt central directory entry #${i} (missing signature).`);
      }
      const method     = dv.getUint16(p + 10, true);
      const csize      = dv.getUint32(p + 20, true);
      const nameLen    = dv.getUint16(p + 28, true);
      const extraLen   = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const lhdrOffs   = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      // Skip directory entries (trailing slash, size 0).
      if (name.endsWith('/')) continue;

      if (dv.getUint32(lhdrOffs, true) !== 0x04034b50) {
        throw new Error(`Corrupt local header for ${name}.`);
      }
      const lhdrNameLen  = dv.getUint16(lhdrOffs + 26, true);
      const lhdrExtraLen = dv.getUint16(lhdrOffs + 28, true);
      const dataStart = lhdrOffs + 30 + lhdrNameLen + lhdrExtraLen;
      const data = bytes.subarray(dataStart, dataStart + csize);

      let raw;
      if (method === 0) {
        raw = data;
      } else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error(
            `Entry ${name} uses DEFLATE but this browser has no ` +
            `DecompressionStream — re-zip with "stored" method.`);
        }
        const stream = new Blob([data]).stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        raw = new Uint8Array(buf);
      } else {
        throw new Error(
          `Entry ${name}: unsupported compression method ${method} ` +
          `(only stored and deflate are read).`);
      }
      out.push({ path: name, content: dec.decode(raw) });
    }
    return out;
  }

  return { encode, decode, crc32 };
})();
