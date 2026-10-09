// RGSS3A (RPG Maker VX Ace encrypted archive) reader/writer.
// Format (verified against rgss3a_dec.py reference implementation):
//   header  : "RGSSAD" 0x00 0x03  (8 bytes)
//   magic   : u32 LE seed        (4 bytes, raw)
//   key     : (magic * 9 + 3) & 0xFFFFFFFF  -- fixed for the whole directory
//   entries : while true {
//               offset  = u32 ^ key;  if offset == 0 => end of directory
//               size    = u32 ^ key;
//               fileKey = u32 ^ key;
//               nameLen = u32 ^ key;
//               name bytes, each byte ^= (key >> ((i % 4) * 8)) & 0xFF
//             }
//   data    : each file at its recorded offset, encrypted with its own fileKey:
//               for every 4-byte word: word ^= fileKey; fileKey = (fileKey*7+3) & 0xFFFFFFFF
//               trailing partial bytes ^= (fileKey >> ((i % 4) * 8)) & 0xFF
// Encryption and decryption are the same operation (XOR stream).
"use strict";

function readArchive(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 6) !== "RGSSAD") throw new Error("Not RGSSAD");
  const version = buf[7];
  if (version !== 3) throw new Error("Unsupported RGSSAD version: " + version);
  let pos = 8;
  const magic = buf.readUInt32LE(pos);
  pos += 4;
  const key = (Math.imul(magic, 9) + 3) >>> 0;
  const entries = [];

  function u32() {
    const v = buf.readUInt32LE(pos);
    pos += 4;
    return v;
  }

  for (;;) {
    const offset = u32() ^ key;
    if (offset === 0) break;
    const size = u32() ^ key;
    const fileKey = u32() ^ key;
    const nameLen = u32() ^ key;
    if (nameLen > 4096 || pos + nameLen > buf.length) throw new Error("Bad name length in RGSS3A directory");
    const nameBytes = Buffer.alloc(nameLen);
    for (let i = 0; i < nameLen; i++) {
      nameBytes[i] = buf[pos++] ^ ((key >>> ((i % 4) * 8)) & 0xff);
    }
    const name = nameBytes.toString("utf8");
    entries.push({ name, size, offset, fileKey });
  }
  return { version, magic, key, entries, buf };
}

// ---------------- directory field crypto ----------------
// Directory fields (offset/size/fileKey/nameLength and the name bytes) are XORed
// with a FIXED 4-byte pattern derived from the directory key — the key does NOT
// advance inside a field. Only the file *data* block advances its key every 4
// bytes (see the data codec below). Getting this backwards silently corrupts
// every name in the archive, which is why both writers below use this helper.
function xorFixed(buf, key) {
  const out = Buffer.from(buf);
  const k = key >>> 0;
  for (let i = 0; i < out.length; i++) out[i] ^= (k >>> ((i % 4) * 8)) & 0xff;
  return out;
}

// ---------------- file data codec ----------------
// The data keystream advances its 32-bit key once per 4 BYTES of that entry:
//   key(i) = key(i-1)*7 + 3 (mod 2^32), and byte j of the word is taken from
//   bits (j%4)*8..+8 of the key.
// The key sequence is period-2^30 at best and NOT periodic at any small size, so
// a small table indexed by `word % N` is wrong beyond N words (an earlier version
// of this file did exactly that and silently corrupted files >16 KB). Instead the
// key bytes are expanded into a byte table of a few MB, re-derived rarely.
const KEY_BYTES_TARGET = 64 * 1024 * 1024; // 64 MB of keystream = 16M words
const STREAMS = new Map();
function keyBytesTable(seedKey) {
  const k = seedKey >>> 0;
  let t = STREAMS.get(k);
  if (t) return t;
  const bytes = Buffer.alloc(KEY_BYTES_TARGET);
  let key = k;
  let o = 0;
  const words = KEY_BYTES_TARGET >>> 2;
  for (let w = 0; w < words; w++) {
    bytes[o] = key & 0xff;
    bytes[o + 1] = (key >>> 8) & 0xff;
    bytes[o + 2] = (key >>> 16) & 0xff;
    bytes[o + 3] = (key >>> 24) & 0xff;
    key = (Math.imul(key, 7) + 3) >>> 0;
    o += 4;
  }
  t = { bytes, lastKey: key };
  STREAMS.set(k, t);
  return t;
}

// Byte at keystream position `pos`, extending the table when needed.
function ensureKeyBytes(seedKey, pos) {
  const t = keyBytesTable(seedKey);
  if (pos + 8 < t.bytes.length) return t.bytes;
  // Grow on demand (rare: only files larger than 256 MB, split per entry anyway).
  const need = Math.min(Math.max(t.bytes.length * 2, pos + 1024), 2048 * 1024 * 1024);
  const bigger = Buffer.alloc(need);
  t.bytes.copy(bigger);
  let key = t.lastKey >>> 0;
  for (let o = t.bytes.length; o < need; o += 4) {
    bigger[o] = key & 0xff;
    bigger[o + 1] = (key >>> 8) & 0xff;
    bigger[o + 2] = (key >>> 16) & 0xff;
    bigger[o + 3] = (key >>> 24) & 0xff;
    key = (Math.imul(key, 7) + 3) >>> 0;
  }
  t.bytes = bigger;
  t.lastKey = key;
  return t.bytes;
}

// Transform `data` in place; `byteOffset` is the keystream position of data[0].
// Returns the number of bytes transformed.
function xorTransformAt(data, seedKey, byteOffset) {
  const pos = byteOffset || 0;
  const bytes = ensureKeyBytes(seedKey, pos + data.length);
  const n = data.length;
  for (let i = 0; i < n; i++) data[i] ^= bytes[pos + i];
  return n;
}

// Whole-buffer convenience wrapper.
function xorTransform(data, seedKey, byteOffset) {
  xorTransformAt(data, seedKey, byteOffset || 0);
  return data.length;
}

function decryptBlock(data, fileKey) {
  const out = Buffer.from(data);
  xorTransform(out, fileKey >>> 0, 0);
  return out;
}

function extractFile(archive, entry) {
  const data = archive.buf.subarray(entry.offset, entry.offset + entry.size);
  if (data.length !== entry.size) throw new Error("Truncated data for " + entry.name);
  return decryptBlock(data, entry.fileKey);
}

// entries: [{ name, data: Buffer }] (name uses "/" or "\" separators; backslashes preserved)
function writeArchive(entries) {
  const chunks = [];
  const header = Buffer.alloc(12);
  header.write("RGSSAD", 0, 6, "latin1");
  header[6] = 0;
  header[7] = 3;
  const magic = 0x0011b3a1; // arbitrary seed; (magic*9+3) yields a nonzero key
  header.writeUInt32LE(magic, 8);
  chunks.push(header);
  const key = (Math.imul(magic, 9) + 3) >>> 0;

  // directory size
  let dataStart = 8 + 4;
  for (const e of entries) {
    dataStart += 16 + Buffer.byteLength(e.name, "utf8");
  }
  dataStart += 4; // terminator

  function encDir(buf) {
    return xorFixed(buf, key);
  }
  function u32Buf(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    return b;
  }

  let off = dataStart;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    chunks.push(encDir(u32Buf(off)));
    chunks.push(encDir(u32Buf(e.data.length)));
    chunks.push(encDir(u32Buf(0xdeadcafe)));
    chunks.push(encDir(u32Buf(nameBuf.length)));
    chunks.push(encDir(nameBuf));
    off += e.data.length;
  }
  chunks.push(encDir(u32Buf(0))); // terminator offset=0 => 0^key

  for (const e of entries) chunks.push(decryptBlock(e.data, 0xdeadcafe));
  return Buffer.concat(chunks);
}

// Streaming variant: entries = [{ name, size, buf }] or [{ name, size, file }].
// Writes the archive directly to outPath without holding the whole output in
// memory. Data is encrypted with the same algorithm (per-entry key 0xDEADCAFE).
function writeArchiveTo(entries, outPath) {
  const fs = require("fs");
  const fd = fs.openSync(outPath, "w");
  try {
    const header = Buffer.alloc(12);
    header.write("RGSSAD", 0, 6, "latin1");
    header[6] = 0;
    header[7] = 3;
    const magic = 0x0011b3a1;
    header.writeUInt32LE(magic, 8);
    fs.writeSync(fd, header);
    const key = (Math.imul(magic, 9) + 3) >>> 0;

    let dataStart = 12;
    for (const e of entries) dataStart += 16 + Buffer.byteLength(e.name, "utf8");
    dataStart += 4;

    function encDir(buf) {
      return xorFixed(buf, key);
    }
    function u32Buf(v) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v >>> 0, 0);
      return b;
    }

    let off = dataStart;
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, "utf8");
      fs.writeSync(fd, encDir(u32Buf(off)));
      fs.writeSync(fd, encDir(u32Buf(e.size)));
      fs.writeSync(fd, encDir(u32Buf(0xdeadcafe)));
      fs.writeSync(fd, encDir(u32Buf(nameBuf.length)));
      fs.writeSync(fd, encDir(nameBuf));
      off += e.size;
    }
    fs.writeSync(fd, encDir(u32Buf(0)));

    // Chunks are transformed as one continuous keystream per entry, so any chunk
    // size produces exactly the bytes the whole-buffer transform would. Because
    // CHUNK is a multiple of 4 the carry is empty on every chunk except the last,
    // so the common path does no copying at all.
    const CHUNK = 8 * 1024 * 1024;
    for (const e of entries) {
      let state = 0; // keystream bytes already produced for this entry
      let carry = null;
      const handle = (view) => {
        // Transform a COPY: the caller's buffers (typically file contents read
        // into memory) must not be modified, otherwise a second repack of the
        // same list would encrypt already-encrypted data.
        const out = Buffer.from(view);
        const done = xorTransformAt(out, 0xdeadcafe, state);
        fs.writeSync(fd, out.subarray(0, done));
        state += done;
        carry = done < out.length ? Buffer.from(out.subarray(done)) : null;
      };
      const feed = (chunk) => {
        if (!carry) { handle(chunk); return; }
        const merged = Buffer.concat([carry, chunk]);
        carry = null;
        handle(merged);
      };
      if (e.buf) {
        for (let pos = 0; pos < e.buf.length; pos += CHUNK) feed(e.buf.subarray(pos, Math.min(pos + CHUNK, e.buf.length)));
      } else {
        const fdr = fs.openSync(e.file, "r");
        try {
          let remaining = e.size;
          const chunk = Buffer.alloc(CHUNK);
          while (remaining > 0) {
            const n = fs.readSync(fdr, chunk, 0, Math.min(CHUNK, remaining), null);
            if (n <= 0) throw new Error("short read for " + e.name);
            feed(chunk.subarray(0, n));
            remaining -= n;
          }
        } finally {
          fs.closeSync(fdr);
        }
      }
      if (carry) {
        // Trailing partial word of an unaligned entry: XOR it with the remaining
        // keystream bytes.
        const view = Buffer.from(carry);
        xorTransformAt(view, 0xdeadcafe, state);
        fs.writeSync(fd, view);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readArchive, extractFile, writeArchive, decryptBlock, writeArchiveTo, xorTransform, xorTransformAt, xorFixed, keyBytesTable };
