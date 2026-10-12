import { describe, expect, it } from "vitest";
import { encodeProto, decodeProto, protoNumber as n, protoMessage as m, protoString as s, protoChild, protoInteger, protoText, protoVarint } from "./directProto.mjs";

describe("bounded IM protobuf", ()=>{
  it("preserves 64-bit message identifiers beyond JS's safe integer range", ()=>{
    const id = "7654321098765432100";
    const decoded = decodeProto(encodeProto([n(1,id),m(6,[n(301,18446744073709551615n),s(2,"消息")])]));
    expect(protoInteger(decoded,1)).toBe(id);
    expect(protoInteger(protoChild(decoded,6),301)).toBe("18446744073709551615");
    expect(protoText(protoChild(decoded,6),2)).toBe("消息");
  });
  it.each([Buffer.from([0]), Buffer.from([8,128]), Buffer.from([10,4,1]), Buffer.from([8,...Array(9).fill(255),2]), Buffer.from([15])])("rejects malformed wire input %j", bytes=>{
    expect(()=>decodeProto(bytes)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });
  it("rejects values and messages above its protocol bounds", ()=>{
    expect(()=>protoVarint(18446744073709551616n)).toThrow();
    expect(()=>decodeProto(Buffer.alloc(24*1024*1024+1))).toThrow();
  });
});
