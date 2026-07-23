const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  return value >>> 0;
});

function calculatePngChunkCrc(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isCompletePngBuffer(value) {
  if (
    !Buffer.isBuffer(value)
    || value.length < PNG_SIGNATURE.length + PNG_CHUNK_OVERHEAD_BYTES
    || !value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return false;
  }

  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;

  while (offset + PNG_CHUNK_OVERHEAD_BYTES <= value.length) {
    const dataLength = value.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + dataLength;
    const chunkEnd = crcOffset + 4;

    if (chunkEnd > value.length) {
      return false;
    }

    const expectedCrc = value.readUInt32BE(crcOffset);
    const actualCrc = calculatePngChunkCrc(value, typeOffset, crcOffset);
    if (actualCrc !== expectedCrc) {
      return false;
    }

    const type = value.toString("ascii", typeOffset, dataOffset);
    if (!sawHeader) {
      if (type !== "IHDR" || dataLength !== 13) {
        return false;
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }

    if (type === "IDAT") {
      sawImageData = true;
    }

    if (type === "IEND") {
      return dataLength === 0 && sawHeader && sawImageData && chunkEnd === value.length;
    }

    offset = chunkEnd;
  }

  return false;
}

module.exports = {
  isCompletePngBuffer,
};
