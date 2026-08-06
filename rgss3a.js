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

function decryptBlock(data, fileKey) {
  const out = Buffer.alloc(data.length);
  let key = fileKey >>> 0;
  for (let i = 0; i < data.length; i++) {
    if (i > 0 && i % 4 === 0) key = (Math.imul(key, 7) + 3) >>> 0;
    out[i] = data[i] ^ ((key >>> ((i % 4) * 8)) & 0xff);
  }
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
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ ((key >>> ((i % 4) * 8)) & 0xff);
    }
    return out;
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
      const out = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ ((key >>> ((i % 4) * 8)) & 0xff);
      return out;
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

    const CHUNK = 8 * 1024 * 1024;
    for (const e of entries) {
      let key = 0xdeadcafe;
      const writeBlock = (chunk) => {
        const out = Buffer.alloc(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          if (i > 0 && i % 4 === 0) key = (Math.imul(key, 7) + 3) >>> 0;
          out[i] = chunk[i] ^ ((key >>> ((i % 4) * 8)) & 0xff);
        }
        fs.writeSync(fd, out);
      };
      if (e.buf) {
        for (let pos = 0; pos < e.buf.length; pos += CHUNK) {
          writeBlock(e.buf.subarray(pos, Math.min(pos + CHUNK, e.buf.length)));
        }
      } else {
        const fdr = fs.openSync(e.file, "r");
        try {
          let remaining = e.size;
          const chunk = Buffer.alloc(CHUNK);
          while (remaining > 0) {
            const n = fs.readSync(fdr, chunk, 0, Math.min(CHUNK, remaining), null);
            if (n <= 0) throw new Error("short read for " + e.name);
            writeBlock(chunk.subarray(0, n));
            remaining -= n;
          }
        } finally {
          fs.closeSync(fdr);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readArchive, extractFile, writeArchive, decryptBlock, writeArchiveTo };
