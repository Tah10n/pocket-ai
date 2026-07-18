const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_OVERHEAD_BYTES = 12;

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
    const chunkEnd = dataOffset + dataLength + 4;

    if (chunkEnd > value.length) {
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
