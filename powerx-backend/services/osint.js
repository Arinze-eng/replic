// ─────────────────────────────────────────────────────────────────────────────
// 🔎 OSINT IMAGE METADATA EXTRACTOR  (services/osint.js)
// ─────────────────────────────────────────────────────────────────────────────
// A fully SELF-CONTAINED, ZERO-DEPENDENCY image forensics engine. Given raw
// image bytes it extracts:
//   • Format, dimensions, colour depth, MIME
//   • Full EXIF / TIFF IFD tags (camera make/model, lens, exposure, ISO, etc.)
//   • Timestamps — DateTimeOriginal / DateTimeDigitized / DateTime (when taken)
//   • GPS IFD → decimal lat/lng, altitude, timestamp + Google/OSM map links
//   • Software / editing tool, orientation, artist, copyright
//   • File hashes (MD5, SHA-1, SHA-256) for forensic fingerprinting
//   • PNG tEXt/iTXt, GIF, WebP, BMP header data
//   • A human-readable summary + confidence + privacy-risk notes
//
// Design contract (identical to services/scamDetector.js):
//   • Pure Node — NO network, NO external npm deps → can never hang the gateway.
//   • NEVER throws — a parse error degrades to an honest partial result.
//   • Works on Buffer OR base64 data-URL string input.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// ── EXIF TIFF tag dictionaries ──────────────────────────────────────────────
const EXIF_TAGS = {
  0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0x0102: 'BitsPerSample',
  0x0103: 'Compression', 0x0106: 'PhotometricInterpretation',
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model',
  0x0111: 'StripOffsets', 0x0112: 'Orientation', 0x0115: 'SamplesPerPixel',
  0x011a: 'XResolution', 0x011b: 'YResolution', 0x0128: 'ResolutionUnit',
  0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
  0x013e: 'WhitePoint', 0x0211: 'YCbCrCoefficients', 0x0213: 'YCbCrPositioning',
  0x8298: 'Copyright', 0x8769: 'ExifIFDPointer', 0x8825: 'GPSInfoIFDPointer',
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram',
  0x8827: 'ISO', 0x8830: 'SensitivityType', 0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
  0x9101: 'ComponentsConfiguration', 0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue', 0x9203: 'BrightnessValue', 0x9204: 'ExposureBias',
  0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance', 0x9207: 'MeteringMode',
  0x9208: 'LightSource', 0x9209: 'Flash', 0x920a: 'FocalLength',
  0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime',
  0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace', 0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension', 0xa004: 'RelatedSoundFile',
  0xa005: 'InteroperabilityIFDPointer', 0xa20e: 'FocalPlaneXResolution',
  0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit',
  0xa217: 'SensingMethod', 0xa300: 'FileSource', 0xa301: 'SceneType',
  0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio',
  0xa405: 'FocalLengthIn35mmFilm', 0xa406: 'SceneCaptureType',
  0xa408: 'Contrast', 0xa409: 'Saturation', 0xa40a: 'Sharpness',
  0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
  0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber',
  0xa500: 'Gamma',
};

const GPS_TAGS = {
  0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp', 0x0008: 'GPSSatellites',
  0x0009: 'GPSStatus', 0x000a: 'GPSMeasureMode', 0x000b: 'GPSDOP',
  0x000c: 'GPSSpeedRef', 0x000d: 'GPSSpeed', 0x000e: 'GPSTrackRef',
  0x000f: 'GPSTrack', 0x0010: 'GPSImgDirectionRef', 0x0011: 'GPSImgDirection',
  0x0012: 'GPSMapDatum', 0x0013: 'GPSDestLatitudeRef', 0x0014: 'GPSDestLatitude',
  0x0015: 'GPSDestLongitudeRef', 0x0016: 'GPSDestLongitude',
  0x001d: 'GPSDateStamp', 0x001e: 'GPSDifferential',
};

const ORIENTATION = {
  1: 'Normal (0°)', 2: 'Mirrored horizontal', 3: 'Rotated 180°',
  4: 'Mirrored vertical', 5: 'Mirrored + rotated 90° CCW',
  6: 'Rotated 90° CW', 7: 'Mirrored + rotated 90° CW', 8: 'Rotated 90° CCW',
};
const FLASH = {
  0x0: 'No flash', 0x1: 'Flash fired', 0x5: 'Flash fired, no return',
  0x7: 'Flash fired, return detected', 0x9: 'Flash fired (compulsory)',
  0x10: 'No flash (compulsory)', 0x18: 'No flash (auto)',
  0x19: 'Flash fired (auto)', 0x1d: 'Flash fired (auto, no return)',
  0x1f: 'Flash fired (auto, return detected)', 0x20: 'No flash function',
};
const EXPOSURE_PROGRAM = {
  0: 'Not defined', 1: 'Manual', 2: 'Normal program', 3: 'Aperture priority',
  4: 'Shutter priority', 5: 'Creative (slow)', 6: 'Action (fast)',
  7: 'Portrait', 8: 'Landscape',
};
const METERING = {
  0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot',
  4: 'Multi-spot', 5: 'Multi-segment / Pattern', 6: 'Partial', 255: 'Other',
};
const WHITE_BALANCE = { 0: 'Auto', 1: 'Manual' };
const EXPOSURE_MODE = { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' };

// Byte-length per TIFF type.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') {
    let s = input.trim();
    const m = s.match(/^data:[^;]+;base64,(.*)$/i);
    if (m) s = m[1];
    try { return Buffer.from(s, 'base64'); } catch (_) { return Buffer.alloc(0); }
  }
  if (input && input.data) { try { return Buffer.from(input.data); } catch (_) {} }
  return Buffer.alloc(0);
}

// ── Format sniffing + dimensions (no deps) ──────────────────────────────────
function detectFormat(buf) {
  if (buf.length < 4) return { format: 'unknown', mime: 'application/octet-stream' };
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: 'JPEG', mime: 'image/jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { format: 'PNG', mime: 'image/png' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { format: 'GIF', mime: 'image/gif' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { format: 'WEBP', mime: 'image/webp' };
  if (b[0] === 0x42 && b[1] === 0x4d) return { format: 'BMP', mime: 'image/bmp' };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return { format: 'TIFF', mime: 'image/tiff' };
  if (b.toString('ascii', 4, 12).includes('ftypheic') || b.toString('ascii', 4, 12).includes('ftyphei')) return { format: 'HEIC', mime: 'image/heic' };
  if (b.toString('ascii', 4, 12).includes('ftypavif')) return { format: 'AVIF', mime: 'image/avif' };
  return { format: 'unknown', mime: 'application/octet-stream' };
}

function readDimensions(buf, fmt) {
  try {
    if (fmt === 'PNG' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
    }
    if (fmt === 'GIF' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (fmt === 'BMP' && buf.length >= 26) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), bitDepth: buf.readUInt16LE(28) };
    }
    if (fmt === 'WEBP' && buf.length >= 30) {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]; return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }; }
      if (chunk === 'VP8X') return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    }
    if (fmt === 'JPEG') {
      let off = 2;
      while (off < buf.length - 8) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        // SOF markers carry width/height
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buf.readUInt16BE(off + 5);
          const width = buf.readUInt16BE(off + 7);
          const comps = buf[off + 9];
          return { width, height, components: comps, bitDepth: buf[off + 4] };
        }
        const len = buf.readUInt16BE(off + 2);
        off += 2 + len;
      }
    }
  } catch (_) {}
  return {};
}

// ── EXIF (TIFF) parser ──────────────────────────────────────────────────────
// Finds the EXIF APP1 segment in a JPEG (or uses a bare TIFF header) and walks
// IFD0 → ExifIFD → GPSIFD, resolving every tag we know.
function parseExif(buf, fmt) {
  const out = { tags: {}, gps: {}, tiffFound: false };
  try {
    let tiff = -1;
    if (fmt === 'JPEG') {
      let off = 2;
      while (off < buf.length - 4) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
        const len = buf.readUInt16BE(off + 2);
        if (marker === 0xe1) { // APP1
          const hdr = buf.toString('ascii', off + 4, off + 10);
          if (hdr.startsWith('Exif')) { tiff = off + 10; break; }
        }
        off += 2 + len;
      }
    } else if (fmt === 'TIFF') {
      tiff = 0;
    }
    if (tiff < 0 || tiff + 8 > buf.length) return out;

    const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
    const rd16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    const rd32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const rds32 = (o) => le ? buf.readInt32LE(o) : buf.readInt32BE(o);
    out.tiffFound = true;
    out.byteOrder = le ? 'little-endian (II / Intel)' : 'big-endian (MM / Motorola)';

    function readValue(entry) {
      const type = rd16(entry + 2);
      const count = rd32(entry + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      let vOff = entry + 8;
      if (size > 4) vOff = tiff + rd32(entry + 8);
      if (vOff < 0 || vOff + Math.min(size, 1) > buf.length) return null;
      const vals = [];
      try {
        for (let i = 0; i < count; i++) {
          switch (type) {
            case 1: case 6: case 7: vals.push(buf[vOff + i]); break;
            case 2: break; // ascii handled below
            case 3: vals.push(rd16(vOff + i * 2)); break;
            case 8: vals.push((le ? buf.readInt16LE(vOff + i * 2) : buf.readInt16BE(vOff + i * 2))); break;
            case 4: vals.push(rd32(vOff + i * 4)); break;
            case 9: vals.push(rds32(vOff + i * 4)); break;
            case 5: { const n = rd32(vOff + i * 8), d = rd32(vOff + i * 8 + 4); vals.push(d ? n / d : 0); break; }
            case 10: { const n = rds32(vOff + i * 8), d = rds32(vOff + i * 8 + 4); vals.push(d ? n / d : 0); break; }
            default: vals.push(buf[vOff + i]);
          }
        }
        if (type === 2) {
          let str = buf.toString('latin1', vOff, vOff + count).replace(/\0.*$/, '').trim();
          return { type, count, value: str };
        }
        if (type === 7) { // UNDEFINED — return short readable string when printable
          const str = buf.toString('latin1', vOff, vOff + Math.min(count, 64)).replace(/[^\x20-\x7e]/g, '').trim();
          return { type, count, value: vals, ascii: str };
        }
      } catch (_) { return null; }
      return { type, count, value: count === 1 ? vals[0] : vals };
    }

    function walkIFD(ifdOff, dict, target) {
      if (ifdOff < tiff || ifdOff + 2 > buf.length) return -1;
      const n = rd16(ifdOff);
      let next = -1;
      for (let i = 0; i < n; i++) {
        const entry = ifdOff + 2 + i * 12;
        if (entry + 12 > buf.length) break;
        const tag = rd16(entry);
        const name = dict[tag];
        const parsed = readValue(entry);
        if (!name) continue;
        if (name === 'ExifIFDPointer' && parsed) { out._exifPtr = tiff + (parsed.value || 0); continue; }
        if (name === 'GPSInfoIFDPointer' && parsed) { out._gpsPtr = tiff + (parsed.value || 0); continue; }
        if (name === 'InteroperabilityIFDPointer') continue;
        if (parsed) target[name] = parsed.ascii != null && parsed.ascii !== '' ? parsed.ascii : parsed.value;
      }
      try { next = tiff + rd32(ifdOff + 2 + n * 12); } catch (_) { next = -1; }
      return next;
    }

    const ifd0 = tiff + rd32(tiff + 4);
    walkIFD(ifd0, EXIF_TAGS, out.tags);
    if (out._exifPtr) walkIFD(out._exifPtr, EXIF_TAGS, out.tags);
    if (out._gpsPtr) walkIFD(out._gpsPtr, GPS_TAGS, out.gps);
  } catch (_) { /* degrade to whatever we got */ }
  return out;
}

// Convert a GPS DMS rational array → signed decimal degrees.
function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  let dec = Number(dms[0]) + Number(dms[1]) / 60 + Number(dms[2]) / 3600;
  if (!Number.isFinite(dec)) return null;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return Math.round(dec * 1e7) / 1e7;
}

// ── PNG/GIF/WEBP textual chunks ──────────────────────────────────────────────
function parsePngText(buf) {
  const out = {};
  try {
    let off = 8;
    while (off + 8 < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const dataStart = off + 8;
      if (type === 'tEXt' || type === 'iTXt') {
        const raw = buf.slice(dataStart, dataStart + len);
        const nul = raw.indexOf(0);
        if (nul > 0) {
          const key = raw.toString('latin1', 0, nul);
          let val;
          if (type === 'iTXt') {
            // skip: compressionFlag(1) compressionMethod(1) lang(\0) translatedKey(\0)
            let p = nul + 1 + 2;
            const l1 = raw.indexOf(0, p); const l2 = raw.indexOf(0, l1 + 1);
            val = raw.toString('utf8', l2 + 1);
          } else {
            val = raw.toString('latin1', nul + 1);
          }
          if (key) out[key] = String(val).slice(0, 500);
        }
      } else if (type === 'tIME' && len >= 7) {
        out.PngModifyTime = `${buf.readUInt16BE(dataStart)}-${String(buf[dataStart + 2]).padStart(2, '0')}-${String(buf[dataStart + 3]).padStart(2, '0')} ${String(buf[dataStart + 4]).padStart(2, '0')}:${String(buf[dataStart + 5]).padStart(2, '0')}:${String(buf[dataStart + 6]).padStart(2, '0')} UTC`;
      } else if (type === 'gAMA' && len >= 4) {
        out.Gamma = (buf.readUInt32BE(dataStart) / 100000).toFixed(4);
      } else if (type === 'pHYs' && len >= 9) {
        const x = buf.readUInt32BE(dataStart), unit = buf[dataStart + 8];
        if (unit === 1) out.PixelDensity = Math.round(x * 0.0254) + ' DPI';
      }
      if (type === 'IEND') break;
      off = dataStart + len + 4; // + CRC
      if (len < 0 || off <= dataStart) break;
    }
  } catch (_) {}
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧬 ADVANCED RECOVERY LAYER  (added for WhatsApp / social-stripped images)
// WhatsApp, Instagram, Facebook, Telegram (compressed) etc. RE-ENCODE every JPEG
// and physically delete the EXIF/GPS/timestamp bytes before the file ever leaves
// the sender's phone. No tool on earth can read metadata that was deleted. But a
// serious OSINT engine can still recover a LOT from what remains:
//   • XMP packet   (survives some pipelines even when EXIF is gone)
//   • IPTC / Photoshop (APP13) + Adobe (APP14) caption / byline / date
//   • ICC colour profile (device / colour-management fingerprint)
//   • JFIF version + pixel density + embedded thumbnail
//   • JPEG quantization-table fingerprint  → quality % + SOURCE APP guess
//     (WhatsApp has a recognisable re-encode signature)
//   • FILENAME intelligence → recover the capture DATE that WhatsApp keeps in the
//     filename (IMG-YYYYMMDD-WAxxxx) — often the ONLY date left.
//   • Reverse-image-search links so the analyst can still trace the origin.
// ─────────────────────────────────────────────────────────────────────────────

// Walk every JPEG marker segment once; return APP payloads we care about.
function scanJpegSegments(buf) {
  const seg = { app1: [], app2: [], app13: [], app14: [], app0: null, com: [], sofBits: null, dqt: [], hasEOI: false };
  try {
    let off = 2;
    while (off < buf.length - 3) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd9) { seg.hasEOI = true; break; }
      if (marker === 0xda) break; // start of scan — metadata is all before here
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (off + 4 > buf.length) break;
      const len = buf.readUInt16BE(off + 2);
      const dataStart = off + 4, dataEnd = off + 2 + len;
      if (dataEnd > buf.length) break;
      const slice = buf.slice(dataStart, dataEnd);
      if (marker === 0xe0) seg.app0 = slice;
      else if (marker === 0xe1) seg.app1.push(slice);
      else if (marker === 0xe2) seg.app2.push(slice);
      else if (marker === 0xed) seg.app13.push(slice);
      else if (marker === 0xee) seg.app14.push(slice);
      else if (marker === 0xfe) seg.com.push(slice);
      else if (marker === 0xdb) seg.dqt.push(slice); // quantization table
      else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        seg.sofBits = buf[dataStart]; // sample precision
      }
      off = dataEnd;
    }
  } catch (_) {}
  return seg;
}

// Parse JFIF APP0 → version + pixel density + thumbnail presence.
function parseJfif(app0) {
  const out = {};
  try {
    if (!app0 || app0.length < 14) return out;
    if (app0.toString('ascii', 0, 4) !== 'JFIF') return out;
    out.version = app0[5] + '.' + String(app0[6]).padStart(2, '0');
    const unit = app0[7];
    const x = app0.readUInt16BE(8), y = app0.readUInt16BE(10);
    if (unit === 1) out.density = `${x}×${y} DPI`;
    else if (unit === 2) out.density = `${x}×${y} dots/cm`;
    else out.density = `${x}×${y} (aspect ratio)`;
    const tw = app0[12], th = app0[13];
    if (tw && th) out.thumbnail = `${tw}×${th} embedded thumbnail`;
  } catch (_) {}
  return out;
}

// Extract an XMP packet (RDF/XML) that some pipelines keep even after EXIF loss.
function findXmp(buf, app1List) {
  try {
    // Prefer the APP1 that starts with the XMP namespace URI.
    for (const s of (app1List || [])) {
      const head = s.toString('latin1', 0, 32);
      if (head.startsWith('http://ns.adobe.com/xap/1.0/')) {
        const xml = s.toString('utf8', 29);
        const p = xml.indexOf('<x:xmpmeta');
        if (p >= 0) return xml.slice(p);
      }
    }
    // Fallback: brute-scan the whole buffer (covers PNG/WebP/HEIC-in-JPEG wrappers).
    const asStr = buf.toString('latin1');
    const s = asStr.indexOf('<x:xmpmeta');
    if (s >= 0) {
      const e = asStr.indexOf('</x:xmpmeta>', s);
      if (e > s) return asStr.slice(s, e + 12);
    }
  } catch (_) {}
  return null;
}

function pickXml(xml, ...names) {
  for (const n of names) {
    // attribute form:  name="value"
    let m = xml.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]+)"', 'i'));
    if (m && m[1] && m[1].trim()) return m[1].trim();
    // element form:  <name>value</name>
    m = xml.match(new RegExp('<' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*>([^<]+)<', 'i'));
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

// Parse the useful bits of an XMP packet.
function parseXmp(xml) {
  const out = {};
  if (!xml) return out;
  try {
    const created = pickXml(xml, 'xmp:CreateDate', 'photoshop:DateCreated', 'exif:DateTimeOriginal', 'dc:date');
    const modified = pickXml(xml, 'xmp:ModifyDate', 'exif:DateTime');
    const soft = pickXml(xml, 'xmp:CreatorTool', 'tiff:Software', 'Software');
    const make = pickXml(xml, 'tiff:Make');
    const model = pickXml(xml, 'tiff:Model');
    const lens = pickXml(xml, 'exifEX:LensModel', 'aux:Lens');
    const creator = pickXml(xml, 'dc:creator', 'photoshop:AuthorsPosition', 'Iptc4xmpCore:CreatorContactInfo');
    const desc = pickXml(xml, 'dc:description', 'photoshop:Headline', 'dc:title');
    const city = pickXml(xml, 'photoshop:City', 'Iptc4xmpCore:LocationShownCity');
    const country = pickXml(xml, 'photoshop:Country', 'Iptc4xmpCore:CountryName');
    const lat = pickXml(xml, 'exif:GPSLatitude');
    const lon = pickXml(xml, 'exif:GPSLongitude');
    if (created) out.created = created;
    if (modified) out.modified = modified;
    if (soft) out.software = soft;
    if (make) out.make = make;
    if (model) out.model = model;
    if (lens) out.lens = lens;
    if (creator) out.creator = creator;
    if (desc) out.description = desc;
    if (city || country) out.location = [city, country].filter(Boolean).join(', ');
    if (lat && lon) out.gps = xmpGps(lat, lon);
  } catch (_) {}
  return out;
}

// XMP GPS is "DDD,MM.mmmmR" (e.g. "40,26.7717N"). Convert to decimal.
function xmpGps(lat, lon) {
  const conv = (v) => {
    const m = String(v).match(/^\s*(\d+)[,;](\d+(?:\.\d+)?)\s*([NSEW])\s*$/i);
    if (m) { let d = Number(m[1]) + Number(m[2]) / 60; if (/[SW]/i.test(m[3])) d = -d; return d; }
    const n = Number(v); return Number.isFinite(n) ? n : null;
  };
  const la = conv(lat), lo = conv(lon);
  if (la == null || lo == null) return null;
  const r = (n) => Math.round(n * 1e7) / 1e7;
  return { latitude: r(la), longitude: r(lo) };
}

// IPTC IIM inside a Photoshop APP13 (8BIM) segment → caption / byline / date.
const IPTC_TAGS = {
  0x0205: 'ObjectName', 0x0219: 'Keywords', 0x0250: 'Byline', 0x0255: 'BylineTitle',
  0x0269: 'City', 0x025a: 'City', 0x0264: 'CountryName', 0x0267: 'OriginalTransmissionRef',
  0x0278: 'Caption', 0x027a: 'CaptionWriter', 0x0205e: 'Credit',
  0x0237: 'DateCreated', 0x023c: 'TimeCreated', 0x025f: 'ProvinceState',
  0x026e: 'Headline', 0x0274: 'Source', 0x0276: 'Copyright',
};
function parseIptc(app13List) {
  const out = {};
  try {
    for (const s of (app13List || [])) {
      if (s.toString('ascii', 0, 14) !== 'Photoshop 3.0\0') continue;
      let i = 14;
      while (i + 12 < s.length) {
        if (s.toString('ascii', i, i + 4) !== '8BIM') { i++; continue; }
        const resId = s.readUInt16BE(i + 4);
        // Pascal name (padded even)
        let nameLen = s[i + 6]; let nameEnd = i + 7 + nameLen; if ((nameLen + 1) % 2 !== 0) nameEnd++;
        const dataLen = s.readUInt32BE(nameEnd);
        const dataStart = nameEnd + 4;
        if (resId === 0x0404) { // IPTC-NAA
          let p = dataStart; const end = dataStart + dataLen;
          while (p + 5 <= end && p + 5 <= s.length) {
            if (s[p] !== 0x1c) { p++; continue; }
            const rec = s[p + 1], ds = s[p + 2], len = s.readUInt16BE(p + 3);
            const key = (rec << 8) | ds;
            const name = IPTC_TAGS[key];
            const val = s.toString('latin1', p + 5, p + 5 + len).replace(/\0.*$/, '').trim();
            if (name && val) out[name] = (out[name] ? out[name] + ', ' : '') + val;
            p += 5 + len;
          }
        }
        i = dataStart + dataLen + (dataLen % 2);
      }
    }
  } catch (_) {}
  return out;
}

// ICC profile (APP2) → device / colour-management fingerprint.
function parseIcc(app2List) {
  try {
    for (const s of (app2List || [])) {
      if (s.toString('ascii', 0, 11) !== 'ICC_PROFILE') continue;
      const body = s.slice(14); // skip "ICC_PROFILE\0" + seq(1) + count(1)
      if (body.length < 128) continue;
      const out = {};
      const cmm = body.toString('ascii', 4, 8).replace(/\0/g, '').trim();
      out.class = body.toString('ascii', 12, 16).replace(/\0/g, '').trim();
      out.colorSpace = body.toString('ascii', 16, 20).replace(/\0/g, '').trim();
      const y = body.readUInt16BE(24), mo = body.readUInt16BE(26), da = body.readUInt16BE(28);
      if (y > 1990 && y < 2100) out.created = `${y}-${pad2(mo)}-${pad2(da)}`;
      out.platform = body.toString('ascii', 40, 44).replace(/\0/g, '').trim();
      if (cmm) out.cmm = cmm;
      // 'desc' tag holds a human profile name (e.g. "Display P3", "sRGB IEC61966-2.1")
      const desc = extractIccDesc(body);
      if (desc) out.name = desc;
      return out;
    }
  } catch (_) {}
  return null;
}
function extractIccDesc(body) {
  try {
    const count = body.readUInt32BE(128);
    for (let i = 0; i < count; i++) {
      const e = 132 + i * 12;
      if (e + 12 > body.length) break;
      const sig = body.toString('ascii', e, e + 4);
      if (sig === 'desc') {
        const off = body.readUInt32BE(e + 4), len = body.readUInt32BE(e + 8);
        const type = body.toString('ascii', off, off + 4);
        if (type === 'desc') { const n = body.readUInt32BE(off + 8); return body.toString('latin1', off + 12, off + 12 + n).replace(/\0.*$/, '').trim(); }
        if (type === 'mluc') { const rec = body.readUInt32BE(off + 8); const rl = body.readUInt32BE(off + 12); const ro = body.readUInt32BE(off + 16); return body.toString('utf16le', off + 16 + 4, off + 16 + 4 + rl).replace(/\u0000/g, '').trim() || body.slice(off + ro, off + ro + rl).swap16().toString('utf16le').replace(/\0/g, '').trim(); }
      }
    }
  } catch (_) {}
  return null;
}

// Estimate JPEG quality (0-100) from the luma quantization table + fingerprint source.
function analyzeDqt(dqtList) {
  try {
    for (const s of (dqtList || [])) {
      let p = 0;
      while (p < s.length) {
        const pqTq = s[p]; const prec = pqTq >> 4; const id = pqTq & 0x0f;
        const n = prec ? 128 : 64;
        const table = [];
        for (let i = 0; i < 64 && p + 1 + (prec ? i * 2 : i) < s.length; i++) {
          table.push(prec ? s.readUInt16BE(p + 1 + i * 2) : s[p + 1 + i]);
        }
        if (id === 0 && table.length === 64) {
          // Standard IJG quality estimate from the sum of the luma table.
          const sum = table.reduce((a, b) => a + b, 0);
          let q;
          if (sum <= 64) q = 100;
          else if (table[0] <= 1) q = 99;
          else {
            // Approximate inverse of the IJG scaling curve.
            const avg = sum / 64;
            q = avg < 20 ? Math.round(100 - avg * 1.4) : Math.round(5000 / avg);
            q = Math.max(1, Math.min(100, q));
          }
          return { quality: q, lumaDcQuant: table[0], tableSum: sum };
        }
        p += 1 + n;
      }
    }
  } catch (_) {}
  return null;
}

// FILENAME INTELLIGENCE — recover date + source app from the file name.
// This is frequently the ONLY capture date left after WhatsApp/social stripping.
function analyzeFilename(name) {
  const out = {};
  if (!name || typeof name !== 'string') return out;
  const f = name.trim();
  out.filename = f;
  const push = (date, source, conf) => { if (!out.recoveredDate) { out.recoveredDate = date; out.source = source; out.dateConfidence = conf; } };
  const fmt = (y, mo, d, hh, mm, ss) => `${y}-${mo}-${d}` + (hh ? ` ${hh}:${mm}:${ss || '00'}` : '');
  let m;
  // WhatsApp:  IMG-20260628-WA0014.jpg  /  VID-20240115-WA0002.mp4
  if ((m = f.match(/^(IMG|VID|AUD|PTT|DOC|STK)-(\d{4})(\d{2})(\d{2})-WA\d+/i))) {
    push(fmt(m[2], m[3], m[4]), 'WhatsApp', 'high'); out.whatsapp = true;
  }
  // Android camera:  IMG_20240115_143022.jpg  /  20240115_143022.jpg
  else if ((m = f.match(/(?:IMG|VID|PXL)[_-]?(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/i))) {
    push(fmt(m[1], m[2], m[3], m[4], m[5], m[6]), /^PXL/i.test(f) ? 'Google Pixel camera' : 'Android camera', 'high');
  }
  // Screenshots:  Screenshot_20240115-143022 / Screenshot 2024-01-15 at ...
  else if ((m = f.match(/Screenshot[_ ]?(\d{4})[-.]?(\d{2})[-.]?(\d{2})[-_ ]?(?:at )?(\d{2})[.:]?(\d{2})/i))) {
    push(fmt(m[1], m[2], m[3], m[4], m[5]), 'Screenshot', 'high'); out.screenshot = true;
  }
  // iOS/general:  2024-01-15 14.30.22  /  2024-01-15T14:30:22
  else if ((m = f.match(/(\d{4})[-_.](\d{2})[-_.](\d{2})[ T_](\d{2})[-_.:](\d{2})[-_.:](\d{2})/))) {
    push(fmt(m[1], m[2], m[3], m[4], m[5], m[6]), 'Filename timestamp', 'medium');
  }
  // Signal:  signal-2024-01-15-143022.jpg
  else if ((m = f.match(/signal[-_](\d{4})[-_](\d{2})[-_](\d{2})[-_ ]?(\d{2})?(\d{2})?/i))) {
    push(fmt(m[1], m[2], m[3], m[4], m[5]), 'Signal', 'high');
  }
  // Unix epoch (ms or s):  1700000000000.jpg / photo_1700000000.jpg
  else if ((m = f.match(/(?:^|[_-])(\d{13})(?:[_.]|$)/))) {
    const d = new Date(Number(m[1])); if (d.getFullYear() > 2000 && d.getFullYear() < 2100) push(d.toISOString().replace('T', ' ').slice(0, 19), 'Unix timestamp (ms)', 'medium');
  }
  else if ((m = f.match(/(?:^|[_-])(\d{10})(?:[_.]|$)/))) {
    const d = new Date(Number(m[1]) * 1000); if (d.getFullYear() > 2000 && d.getFullYear() < 2100) push(d.toISOString().replace('T', ' ').slice(0, 19), 'Unix timestamp (s)', 'medium');
  }
  // Loose date anywhere:  20240115
  else if ((m = f.match(/(20\d{2})(\d{2})(\d{2})/))) {
    const mo = Number(m[2]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) push(fmt(m[1], m[2], m[3]), 'Filename date', 'low');
  }
  // App hints from prefix even without a parseable date
  if (!out.source) {
    if (/whatsapp|-WA\d/i.test(f)) out.source = 'WhatsApp';
    else if (/telegram|photo_\d+@/i.test(f)) out.source = 'Telegram';
    else if (/instagram|FB_IMG|received_/i.test(f)) out.source = 'Facebook / Instagram';
    else if (/snapchat/i.test(f)) out.source = 'Snapchat';
    else if (/screenshot/i.test(f)) { out.source = 'Screenshot'; out.screenshot = true; }
  }
  if (/FB_IMG|received_\d/i.test(f)) { out.source = 'Facebook Messenger'; }
  return out;
}

// ── Main entry point ─────────────────────────────────────────────────────────
function extract(input, opts) {
  opts = opts || {};
  const buf = toBuffer(input);
  const result = {
    ok: true,
    bytes: buf.length,
    sizeHuman: humanBytes(buf.length),
    format: 'unknown', mime: 'application/octet-stream',
    dimensions: null,
    hasExif: false, hasGps: false,
    camera: {}, capture: {}, gps: null, software: null,
    timestamps: {}, device: {},
    exif: {}, extra: {}, hashes: {},
    // ── advanced recovery layer ──
    xmp: {}, iptc: {}, icc: null, jfif: {}, jpegQuality: null,
    origin: {},            // { source, detail, likelyStripped }
    filenameIntel: {},     // { recoveredDate, source, ... }
    reverseSearch: {},     // links to trace the image online
    summary: '', privacy: [], notes: [], confidence: 'low',
  };
  if (!buf.length) { result.ok = false; result.error = 'No image bytes provided.'; return result; }

  // Filename intelligence FIRST — it works for ANY file, even a fully stripped one,
  // and is frequently the only capture date WhatsApp/social apps leave behind.
  try {
    const fi = analyzeFilename(opts.filename || '');
    if (fi && Object.keys(fi).length) {
      result.filenameIntel = fi;
      if (fi.recoveredDate && !result.timestamps.taken) result.timestamps.takenFromFilename = fi.recoveredDate;
    }
  } catch (_) {}

  // Hashes (forensic fingerprint) — always available.
  try {
    result.hashes = {
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      sha1: crypto.createHash('sha1').update(buf).digest('hex'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  } catch (_) {}

  const det = detectFormat(buf);
  result.format = det.format; result.mime = det.mime;

  const dim = readDimensions(buf, det.format);
  if (dim.width && dim.height) {
    result.dimensions = { width: dim.width, height: dim.height, megapixels: Math.round((dim.width * dim.height) / 1e5) / 10 };
    if (dim.bitDepth) result.dimensions.bitDepth = dim.bitDepth;
  }

  // EXIF for formats that carry it
  if (det.format === 'JPEG' || det.format === 'TIFF') {
    const ex = parseExif(buf, det.format);
    result.hasExif = ex.tiffFound && (Object.keys(ex.tags).length > 0 || Object.keys(ex.gps).length > 0);
    result.exif = ex.tags;
    if (ex.byteOrder) result.extra.byteOrder = ex.byteOrder;

    const t = ex.tags;
    // Camera / lens
    if (t.Make) result.camera.make = String(t.Make).trim();
    if (t.Model) result.camera.model = String(t.Model).trim();
    if (t.LensModel) result.camera.lens = String(t.LensModel).trim();
    if (t.LensMake) result.camera.lensMake = String(t.LensMake).trim();
    // Capture settings
    if (t.FNumber != null) result.capture.aperture = 'f/' + round(t.FNumber, 1);
    if (t.ExposureTime != null) result.capture.shutter = fmtShutter(t.ExposureTime);
    if (t.ISO != null) result.capture.iso = t.ISO;
    if (t.FocalLength != null) result.capture.focalLength = round(t.FocalLength, 1) + ' mm';
    if (t.FocalLengthIn35mmFilm != null) result.capture.focalLength35mm = t.FocalLengthIn35mmFilm + ' mm';
    if (t.Flash != null) result.capture.flash = FLASH[t.Flash] || ('0x' + Number(t.Flash).toString(16));
    if (t.Orientation != null) result.capture.orientation = ORIENTATION[t.Orientation] || String(t.Orientation);
    if (t.ExposureProgram != null) result.capture.exposureProgram = EXPOSURE_PROGRAM[t.ExposureProgram] || String(t.ExposureProgram);
    if (t.MeteringMode != null) result.capture.metering = METERING[t.MeteringMode] || String(t.MeteringMode);
    if (t.WhiteBalance != null) result.capture.whiteBalance = WHITE_BALANCE[t.WhiteBalance] != null ? WHITE_BALANCE[t.WhiteBalance] : String(t.WhiteBalance);
    if (t.ExposureMode != null) result.capture.exposureMode = EXPOSURE_MODE[t.ExposureMode] != null ? EXPOSURE_MODE[t.ExposureMode] : String(t.ExposureMode);
    if (t.DigitalZoomRatio != null && t.DigitalZoomRatio > 0) result.capture.digitalZoom = round(t.DigitalZoomRatio, 2) + '×';
    // Software / authorship / device
    if (t.Software) result.software = String(t.Software).trim();
    if (t.Artist) result.device.artist = String(t.Artist).trim();
    if (t.CameraOwnerName) result.device.owner = String(t.CameraOwnerName).trim();
    if (t.Copyright) result.device.copyright = String(t.Copyright).trim();
    if (t.BodySerialNumber) result.device.serial = String(t.BodySerialNumber).trim();
    if (t.LensSerialNumber) result.device.lensSerial = String(t.LensSerialNumber).trim();
    if (t.ImageDescription) result.extra.description = String(t.ImageDescription).trim();
    if (t.UserComment && typeof t.UserComment === 'string') result.extra.userComment = t.UserComment.trim();
    // Timestamps
    if (t.DateTimeOriginal) result.timestamps.taken = normDate(t.DateTimeOriginal);
    if (t.DateTimeDigitized) result.timestamps.digitized = normDate(t.DateTimeDigitized);
    if (t.DateTime) result.timestamps.modified = normDate(t.DateTime);

    // GPS
    const g = ex.gps;
    if (g && (g.GPSLatitude || g.GPSLongitude)) {
      const lat = dmsToDecimal(g.GPSLatitude, g.GPSLatitudeRef);
      const lng = dmsToDecimal(g.GPSLongitude, g.GPSLongitudeRef);
      if (lat != null && lng != null) {
        result.hasGps = true;
        const gps = {
          latitude: lat, longitude: lng,
          latitudeRef: g.GPSLatitudeRef, longitudeRef: g.GPSLongitudeRef,
          coordinates: `${lat}, ${lng}`,
          googleMaps: `https://www.google.com/maps?q=${lat},${lng}`,
          openStreetMap: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`,
        };
        if (g.GPSAltitude != null) {
          const alt = round(g.GPSAltitude, 1);
          gps.altitude = (g.GPSAltitudeRef === 1 ? '-' : '') + alt + ' m';
        }
        if (Array.isArray(g.GPSTimeStamp)) {
          const hh = pad2(g.GPSTimeStamp[0]), mm = pad2(g.GPSTimeStamp[1]), ss = pad2(Math.round(g.GPSTimeStamp[2]));
          gps.utcTime = `${hh}:${mm}:${ss} UTC`;
        }
        if (g.GPSDateStamp) gps.utcDate = String(g.GPSDateStamp).replace(/:/g, '-').trim();
        if (g.GPSImgDirection != null) gps.direction = round(g.GPSImgDirection, 1) + '° ' + (g.GPSImgDirectionRef || '');
        if (g.GPSSpeed != null) gps.speed = round(g.GPSSpeed, 1) + ' ' + ({ K: 'km/h', M: 'mph', N: 'knots' }[g.GPSSpeedRef] || '');
        if (g.GPSMapDatum) gps.datum = String(g.GPSMapDatum).trim();
        if (g.GPSSatellites) gps.satellites = String(g.GPSSatellites).trim();
        result.gps = gps;
      }
    }

    // ── ADVANCED JPEG segment analysis (XMP / IPTC / ICC / JFIF / DQT) ──
    if (det.format === 'JPEG') {
      const seg = scanJpegSegments(buf);

      // JFIF header (version / density / thumbnail)
      const jfif = parseJfif(seg.app0);
      if (Object.keys(jfif).length) result.jfif = jfif;

      // XMP packet — often survives when EXIF is gone
      const xmpXml = findXmp(buf, seg.app1);
      const xmp = parseXmp(xmpXml);
      if (Object.keys(xmp).length) {
        result.xmp = xmp;
        result.hasXmp = true;
        if (xmp.created && !result.timestamps.taken) result.timestamps.taken = normDate(xmp.created);
        if (xmp.modified && !result.timestamps.modified) result.timestamps.modified = normDate(xmp.modified);
        if (xmp.software && !result.software) result.software = xmp.software;
        if (xmp.make && !result.camera.make) result.camera.make = xmp.make;
        if (xmp.model && !result.camera.model) result.camera.model = xmp.model;
        if (xmp.lens && !result.camera.lens) result.camera.lens = xmp.lens;
        if (xmp.creator && !result.device.artist) result.device.artist = xmp.creator;
        if (xmp.description && !result.extra.description) result.extra.description = xmp.description;
        if (xmp.location) result.extra.locationName = xmp.location;
        if (xmp.gps && !result.hasGps) {
          const la = xmp.gps.latitude, lo = xmp.gps.longitude;
          result.hasGps = true;
          result.gps = {
            latitude: la, longitude: lo, coordinates: `${la}, ${lo}`,
            source: 'XMP',
            googleMaps: `https://www.google.com/maps?q=${la},${lo}`,
            openStreetMap: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}`,
          };
        }
      }

      // IPTC / Photoshop caption block
      const iptc = parseIptc(seg.app13);
      if (Object.keys(iptc).length) {
        result.iptc = iptc;
        if (iptc.Byline && !result.device.artist) result.device.artist = iptc.Byline;
        if (iptc.Copyright && !result.device.copyright) result.device.copyright = iptc.Copyright;
        if ((iptc.Caption || iptc.Headline) && !result.extra.description) result.extra.description = iptc.Caption || iptc.Headline;
        if ((iptc.City || iptc.CountryName) && !result.extra.locationName) result.extra.locationName = [iptc.City, iptc.ProvinceState, iptc.CountryName].filter(Boolean).join(', ');
        if (iptc.DateCreated && !result.timestamps.taken) {
          const d = String(iptc.DateCreated).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
          result.timestamps.taken = d + (iptc.TimeCreated ? ' ' + String(iptc.TimeCreated).replace(/(\d{2})(\d{2})(\d{2}).*/, '$1:$2:$3') : '');
        }
      }

      // ICC colour profile (device / colour-management fingerprint)
      const icc = parseIcc(seg.app2);
      if (icc) { result.icc = icc; if (icc.created && !result.timestamps.iccCreated) result.timestamps.iccCreated = icc.created; }

      // Adobe APP14 marker → almost always means the file was processed by Adobe.
      if (seg.app14 && seg.app14.length && !result.software) {
        result.extra.adobeMarker = true;
      }

      // JPEG comment segments
      if (seg.com && seg.com.length) {
        const c = seg.com.map(s => s.toString('latin1').replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean).join(' | ');
        if (c) result.extra.jpegComment = c.slice(0, 500);
      }

      // Quality + source fingerprint from the quantization table
      const dq = analyzeDqt(seg.dqt);
      if (dq) { result.jpegQuality = dq.quality; result.extra.jpegQualityDetail = `${dq.quality}% (luma DC quant ${dq.lumaDcQuant})`; }

      result._seg = { hasApp1: seg.app1.length > 0, hasEOI: seg.hasEOI, dqtCount: seg.dqt.length };
    }
  }

  // PNG textual + timing chunks
  if (det.format === 'PNG') {
    const png = parsePngText(buf);
    if (Object.keys(png).length) {
      result.extra.png = png;
      if (png['Creation Time']) result.timestamps.taken = png['Creation Time'];
      if (png.PngModifyTime) result.timestamps.modified = png.PngModifyTime;
      if (png.Software) result.software = png.Software;
      if (png.Author || png.Artist) result.device.artist = png.Author || png.Artist;
      if (png.Copyright) result.device.copyright = png.Copyright;
    }
    // XMP inside PNG iTXt is also picked up by the whole-buffer XMP scan
    const xmpXml = findXmp(buf, []);
    const xmp = parseXmp(xmpXml);
    if (Object.keys(xmp).length) {
      result.xmp = xmp; result.hasXmp = true;
      if (xmp.created && !result.timestamps.taken) result.timestamps.taken = normDate(xmp.created);
      if (xmp.software && !result.software) result.software = xmp.software;
      if (xmp.gps && !result.hasGps) {
        const la = xmp.gps.latitude, lo = xmp.gps.longitude;
        result.hasGps = true;
        result.gps = { latitude: la, longitude: lo, coordinates: `${la}, ${lo}`, source: 'XMP', googleMaps: `https://www.google.com/maps?q=${la},${lo}`, openStreetMap: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}` };
      }
    }
    if (dim.colorType != null) {
      const CT = { 0: 'Grayscale', 2: 'RGB', 3: 'Palette', 4: 'Grayscale+Alpha', 6: 'RGBA' };
      result.extra.colorType = CT[dim.colorType] || String(dim.colorType);
    }
  }

  // ── Origin / source fingerprint (why metadata may be missing) ──
  detectOrigin(result);

  // ── Reverse-image-search links (trace the image even with zero metadata) ──
  try {
    const sha = result.hashes && result.hashes.sha256 ? result.hashes.sha256.slice(0, 16) : '';
    result.reverseSearch = {
      google: 'https://lens.google.com/uploadbyurl',
      googleImages: 'https://www.google.com/imghp',
      tineye: 'https://tineye.com/',
      yandex: 'https://yandex.com/images/',
      bing: 'https://www.bing.com/visualsearch',
      note: 'Upload the image to these engines to find where it appears online — the fastest way to trace origin when EXIF has been stripped.',
      fingerprint: sha,
    };
  } catch (_) {}

  // ── Confidence + privacy + summary ──
  buildAssessment(result);
  return result;
}

// Work out where an image most likely came from and whether metadata was stripped.
function detectOrigin(r) {
  const o = { likelyStripped: false, signals: [] };
  const fi = r.filenameIntel || {};
  const isJpeg = r.format === 'JPEG';

  // Strong filename signals first.
  if (fi.whatsapp) { o.source = 'WhatsApp'; o.detail = 'Filename matches the WhatsApp pattern (IMG-YYYYMMDD-WA####).'; }
  else if (fi.screenshot) { o.source = 'Screenshot'; o.detail = 'Filename indicates a screen capture.'; }
  else if (fi.source) { o.source = fi.source; o.detail = 'Inferred from the filename.'; }

  // JPEG with NO EXIF/XMP but a bare JFIF header = classic social re-encode.
  const noMeta = isJpeg && !r.hasExif && !r.hasXmp && !(r.iptc && Object.keys(r.iptc).length);
  if (noMeta) {
    o.likelyStripped = true;
    o.signals.push('No EXIF, XMP or IPTC block present.');
    if (r.jfif && r.jfif.version) o.signals.push(`Bare JFIF ${r.jfif.version} header (re-encoded, not straight-from-camera).`);
    if (r.jpegQuality) o.signals.push(`Re-compressed at ~${r.jpegQuality}% JPEG quality.`);
    if (!o.source) {
      // WhatsApp typically lands around 70-85% with a stripped JFIF and no thumbnail.
      if (r.jpegQuality && r.jpegQuality >= 70 && r.jpegQuality <= 90 && (!r.jfif || !r.jfif.thumbnail)) {
        o.source = 'Messaging / social app (likely WhatsApp, Instagram or Facebook)';
        o.detail = 'Metadata fully stripped and image re-compressed — the signature of a messaging/social pipeline.';
      } else {
        o.source = 'Metadata-stripped source';
        o.detail = 'EXIF appears to have been removed after capture.';
      }
    }
  } else if (isJpeg && r.hasExif) {
    if (!o.source) { o.source = 'Original / camera file'; o.detail = 'EXIF block is intact — this looks like an original capture (or a copy that preserved metadata).'; }
  }

  if (r.software && /whatsapp/i.test(r.software)) { o.source = 'WhatsApp'; }
  r.origin = o;
}

function buildAssessment(r) {
  const privacy = [];
  const notes = [];
  let score = 0;

  if (r.hasGps && r.gps) {
    score += 3;
    privacy.push(`📍 GPS location is embedded — this reveals exactly WHERE the photo was taken (${r.gps.coordinates}). Anyone with the file can pinpoint it on a map.`);
  }
  if (r.timestamps.taken) { score += 2; }
  if (r.camera.make || r.camera.model) {
    score += 2;
    privacy.push(`📷 Camera/device model is exposed (${[r.camera.make, r.camera.model].filter(Boolean).join(' ')}) — useful for device fingerprinting.`);
  }
  if (r.device.serial || r.device.lensSerial) {
    score += 1;
    privacy.push(`🔑 Hardware serial number(s) present — these uniquely identify the physical device.`);
  }
  if (r.device.owner || r.device.artist) {
    score += 1;
    privacy.push(`👤 Owner / author name is embedded (${r.device.owner || r.device.artist}).`);
  }
  if (r.software) { notes.push(`🛠️ Processed / saved with: ${r.software}${/photoshop|gimp|lightroom|snapseed|affinity/i.test(r.software) ? ' — the image was likely EDITED (not a straight-from-camera original).' : ''}`); }

  // Recovered date from filename (the WhatsApp/social-safe timestamp).
  const fi = r.filenameIntel || {};
  if (fi.recoveredDate) {
    score += 2;
    notes.push(`🗓️ Capture date recovered from the FILENAME: ${fi.recoveredDate}${fi.source ? ` (source: ${fi.source}, ${fi.dateConfidence} confidence)` : ''}. This is often the only date a messaging app preserves.`);
  }

  // Origin / stripping explanation — the key WhatsApp insight.
  const o = r.origin || {};
  if (o.likelyStripped) {
    notes.push(`🧬 This image was RE-ENCODED and its metadata STRIPPED${o.source ? ` by: ${o.source}` : ''}. ${o.detail || ''} EXIF/GPS/timestamps were deleted at the source — no tool can recover bytes that were physically removed.`);
    notes.push('💡 To get full metadata (exact GPS + time taken), obtain the ORIGINAL file: on WhatsApp ask the sender to share it as a Document (📎 → Document), not as a Photo — that bypasses the compression that strips EXIF.');
  } else if (o.source && !o.likelyStripped) {
    notes.push(`🔍 Likely origin: ${o.source}. ${o.detail || ''}`);
  }
  if (r.jpegQuality) notes.push(`📉 Estimated JPEG quality ≈ ${r.jpegQuality}% (from the quantization table).`);
  if (r.icc && r.icc.name) notes.push(`🎨 Embedded ICC colour profile: ${r.icc.name}${r.icc.platform ? ` (platform: ${r.icc.platform})` : ''}.`);
  if (r.extra && r.extra.locationName) { score += 1; privacy.push(`📌 A place name is embedded in the metadata: ${r.extra.locationName}.`); }
  if (r.hasXmp) notes.push('🧾 An XMP metadata packet was found and parsed.');

  if (!r.hasExif && (r.format === 'JPEG' || r.format === 'TIFF') && !r.hasXmp) notes.push('No EXIF block found — metadata may have been stripped (e.g. by a social network) or was never written.');
  if (r.format === 'PNG' && !Object.keys(r.extra.png || {}).length && !r.hasXmp) notes.push('PNG images from screenshots/social apps usually carry no EXIF; only basic header data is available.');
  if (!r.hasGps) notes.push('No GPS coordinates found embedded in this image.');
  notes.push('🔗 Tip: use the reverse-image-search links below to trace where this image appears online — this works even with zero metadata.');

  r.privacy = privacy;
  r.notes = notes;
  r.confidence = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';

  // Human summary
  const parts = [];
  parts.push(`${r.format} image${r.dimensions ? `, ${r.dimensions.width}×${r.dimensions.height}px (${r.dimensions.megapixels} MP)` : ''}, ${r.sizeHuman}.`);
  if (r.camera.make || r.camera.model) parts.push(`Shot on ${[r.camera.make, r.camera.model].filter(Boolean).join(' ')}${r.camera.lens ? ` with ${r.camera.lens}` : ''}.`);
  if (r.timestamps.taken) parts.push(`Taken ${r.timestamps.taken}.`);
  else if (fi.recoveredDate) parts.push(`Capture date (from filename): ${fi.recoveredDate}.`);
  if (r.hasGps && r.gps) parts.push(`Geotagged at ${r.gps.coordinates}.`);
  if (r.capture.aperture || r.capture.shutter || r.capture.iso) {
    parts.push(`Settings: ${[r.capture.aperture, r.capture.shutter, r.capture.iso ? 'ISO ' + r.capture.iso : null, r.capture.focalLength].filter(Boolean).join(', ')}.`);
  }
  if (r.software) parts.push(`Software: ${r.software}.`);
  if (o.source) parts.push(`Likely origin: ${o.source}.`);
  if (!r.hasExif && !r.hasGps && !r.software && !r.hasXmp && !fi.recoveredDate) parts.push('No embedded EXIF/GPS metadata was found (see notes for why and what to do next).');
  r.summary = parts.join(' ');
}

// ── small helpers ─────────────────────────────────────────────────────────
function round(n, d) { const p = Math.pow(10, d || 0); return Math.round(Number(n) * p) / p; }
function pad2(n) { return String(Math.floor(Number(n) || 0)).padStart(2, '0'); }
function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function fmtShutter(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return String(t);
  if (n >= 1) return round(n, 1) + ' s';
  return '1/' + Math.round(1 / n) + ' s';
}
function normDate(s) {
  const str = String(s || '').trim();
  // EXIF format: "YYYY:MM:DD HH:MM:SS"
  const m = str.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return str;
}

module.exports = { extract, detectFormat, humanBytes };
