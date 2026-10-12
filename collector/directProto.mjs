import { DirectHistoryError } from "./directHistory.mjs";

const MAX_BYTES = 24 * 1024 * 1024;
const fail = () => { throw new DirectHistoryError("invalid_response", "消息接口返回了无效的二进制数据。"); };
export function protoVarint(value) {
  let number = BigInt(value);
  if (number < 0n) number = BigInt.asUintN(64, number);
  if (number > 0xffff_ffff_ffff_ffffn) fail();
  const bytes = [];
  do { const byte = Number(number & 127n); number >>= 7n; bytes.push(byte | (number ? 128 : 0)); } while (number);
  return Buffer.from(bytes);
}
export const protoNumber = (field, value) => [field, { wire: 0, value: BigInt(value) }];
export const protoBytes = (field, value) => [field, { wire: 2, value: Buffer.isBuffer(value) ? value : Buffer.from(value) }];
export const protoString = (field, value) => protoBytes(field, String(value));
export const protoMessage = (field, fields) => protoBytes(field, encodeProto(fields));
export const protoMapEntry = (field, key, value) => protoMessage(field, [protoString(1, key), protoString(2, value)]);

export function encodeProto(fields) {
  return Buffer.concat(fields.map(([field, item]) => {
    if (!Number.isInteger(field) || field < 1 || field > 536_870_911) fail();
    const tag = protoVarint(BigInt(field) * 8n + BigInt(item.wire));
    if (item.wire === 0) return Buffer.concat([tag, protoVarint(item.value)]);
    const bytes = Buffer.from(item.value);
    if (item.wire === 2) return Buffer.concat([tag, protoVarint(bytes.length), bytes]);
    if ((item.wire === 1 && bytes.length === 8) || (item.wire === 5 && bytes.length === 4)) return Buffer.concat([tag, bytes]);
    fail();
  }));
}

export function decodeProto(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_BYTES) fail();
  let cursor = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && cursor < bytes.length; shift += 7n) {
      const byte = bytes[cursor++];
      if (shift === 63n && byte > 1) fail();
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    fail();
  };
  const fields = [];
  while (cursor < bytes.length) {
    const tag = varint(), field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!field || field > 536_870_911) fail();
    let value;
    if (wire === 0) value = varint();
    else {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : NaN;
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - cursor) fail();
      value = bytes.subarray(cursor, cursor + length); cursor += length;
    }
    fields.push([field, { wire, value }]);
  }
  return fields;
}
export const protoField = (fields, number) => fields.find(([field]) => field === number)?.[1];
export const protoText = (fields, number) => { const item = protoField(fields, number); return item?.wire === 2 ? item.value.toString("utf8") : ""; };
export const protoInteger = (fields, number) => { const item = protoField(fields, number); return item?.wire === 0 ? item.value.toString() : null; };
export const protoChild = (fields, number) => { const item = protoField(fields, number); return item?.wire === 2 ? decodeProto(item.value) : []; };
export const protoChildren = (fields, number) => fields.filter(([field, item]) => field === number && item.wire === 2).map(([, item]) => decodeProto(item.value));
export const replaceProto = (fields, number, ...items) => [...fields.filter(([field]) => field !== number), ...items].sort(([first], [second]) => first - second);
