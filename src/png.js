const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value) {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = concatBytes([typeBytes, data]);
  return concatBytes([u32(data.length), body, u32(crc32(body))]);
}

/** 无压缩 deflate（存储块），避免依赖 Node zlib，浏览器与 Node 通用。 */
function storeDeflate(bytes) {
  const parts = [];
  const MAX = 65535;
  if (bytes.length === 0) {
    parts.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
  } else {
    for (let offset = 0; offset < bytes.length; offset += MAX) {
      const end = Math.min(bytes.length, offset + MAX);
      const final = end === bytes.length ? 1 : 0;
      const length = end - offset;
      const header = new Uint8Array(5);
      header[0] = final;
      header[1] = length & 0xff;
      header[2] = (length >>> 8) & 0xff;
      header[3] = ~length & 0xff;
      header[4] = (~length >>> 8) & 0xff;
      parts.push(header);
      parts.push(bytes.subarray(offset, end));
    }
  }
  const stored = concatBytes(parts);
  return concatBytes([new Uint8Array([0x78, 0x01]), stored, u32(adler32(bytes))]);
}

/**
 * 可注入的 deflate 实现。
 * - Node：模块加载时用 zlib 同步压缩，输出文件小。
 * - 浏览器：没有 zlib，回退到存储块（仍是合法 PNG）；界面真实导出走
 *   canvas.toBlob 获得浏览器原生压缩。
 */
let deflateImpl = null;

export function setDeflateImplementation(fn) {
  deflateImpl = fn;
}

if (typeof process !== 'undefined' && process.versions?.node) {
  const zlib = await import('node:zlib');
  deflateImpl = (bytes) => zlib.deflateSync(bytes, { level: 6 });
}

/**
 * 把 RGBA8 像素编码成 PNG。带 alpha 时可输出透明底。
 * 无可用压缩器时回退到存储块，仍然是合法 PNG。
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new RangeError('rgba buffer size mismatch');
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = deflateImpl ? deflateImpl(raw) : storeDeflate(raw);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return concatBytes([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
