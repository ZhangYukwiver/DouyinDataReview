import { createPublicKey, createHash, createHmac, createDecipheriv, diffieHellman, hkdfSync, privateDecrypt, constants } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { directSessionFixture, testCookie, serverKeys, traitKeys } from "./fixtures/directClient.mjs";
import { validateDirectCredentials, requireDirectCredentials, directSecurityHeaders, completeDirectCredentialExport } from "./directCredentials.mjs";

describe("paired direct credentials", ()=>{
  it("binds a SDK-verified key and certificate to the account and both Cookie bindings", ()=>{
    const session = directSessionFixture();
    expect(requireDirectCredentials(session).sdkPairVerified).toBe(true);
    expect(validateDirectCredentials(session.security, { ...session, uid: "456" })).toBeNull();
    expect(validateDirectCredentials(session.security, { ...session, userAgent: `${session.userAgent} altered` })).toBeNull();
    for (const name of ["sessionid", "_bd_ticket_crypt_cookie"]) {
      expect(validateDirectCredentials(session.security, { ...session, cookies: session.cookies.map(c=>c.name===name ? { ...c, value: "another-session" } : c) })).toBeNull();
    }
    expect(validateDirectCredentials(session.security, { ...session, cookies: [...session.cookies, testCookie("msToken", "refreshed")] })).not.toBeNull();
    expect(validateDirectCredentials({ ...session.security, sdkPairVerified: false }, session)).toBeNull();
    expect(validateDirectCredentials({ ...session.security, clientCert: session.security.serverCert }, session)).toBeNull();
  });
  it("rejects incomplete material before signing or dispatching", ()=>{
    const session = directSessionFixture();
    expect(()=>requireDirectCredentials({ ...session, security: { ...session.security, dtrait: null } })).toThrowError(expect.objectContaining({ code: "write_credentials_missing" }));
    expect(()=>requireDirectCredentials({ ...session, security: { ...session.security, serverCert: "" } })).toThrowError(expect.objectContaining({ code: "write_credentials_missing" }));
  });
  it.each(["sessionid","_bd_ticket_crypt_cookie"])("refuses SDK verification from before a certificate request rotates %s",async name=>{
    const session=directSessionFixture(),security=session.security;
    const api={session,cookie:()=>"csrf",persistSession:vi.fn(),raw:vi.fn(async()=>{
      session.cookies=session.cookies.map(cookie=>cookie.name===name?{...cookie,value:"rotated-by-server"}:cookie);
      return {text:JSON.stringify({data:{server_cert:security.serverCert,"x-tt-session-dtrait-pk1":Buffer.from(security.dtrait.publicKey).toString("base64"),"x-tt-session-dtrait-pk1-version":"1"}})};
    })};
    const material={...security,trait:{blob:security.dtrait.blob,sdkVersion:security.dtrait.sdkVersion}};
    await expect(completeDirectCredentialExport(api,material)).rejects.toMatchObject({code:"write_credentials_missing"});
    expect(api.raw).toHaveBeenCalledTimes(1);expect(api.persistSession).not.toHaveBeenCalled();
  });
  it("produces a path-bound HMAC that the server's key can verify", ()=>{
    const session = directSessionFixture(), path = "/v1/message/send", timestamp = 1_791_700_000;
    const headers = directSecurityHeaders(session, path, { timestamp });
    const data = JSON.parse(Buffer.from(headers["bd-ticket-guard-client-data"], "base64"));
    const shared = diffieHellman({ privateKey: serverKeys.privateKey, publicKey: createPublicKey(session.security.privateKey) });
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(32), Buffer.alloc(0), 32));
    const verify = pathname=>createHmac("sha256", key).update(`ticket=fake-ticket&path=${pathname}&timestamp=${timestamp}`).digest("base64");
    expect(data.req_sign).toBe(verify(path)); expect(data.req_sign).not.toBe(verify("/another/path"));
    expect(data).toMatchObject({ t_trust: 1, timestamp, req_content: "ticket,path,timestamp" });
    expect(headers["bd-ticket-guard-web-sign-type"]).toBe("1");
  });
  it("encrypts a fresh device header per request, decryptable with the server RSA key", ()=>{
    const session = directSessionFixture(), path = "/aweme/v1/web/comment/publish";
    const first = directSecurityHeaders(session, path), second = directSecurityHeaders(session, path);
    expect(first["x-tt-session-dtrait"]).not.toBe(second["x-tt-session-dtrait"]);
    const [version, rsa, encrypted] = first["x-tt-session-dtrait"].split("_");
    const padded = privateDecrypt({ key: traitKeys.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(rsa, "base64"));
    expect(padded.subarray(0,2)).toEqual(Buffer.from([0,2]));
    const key = Buffer.from(padded.subarray(padded.indexOf(0,2)+1).toString(), "hex");
    const bytes = Buffer.from(encrypted,"base64"), decipher = createDecipheriv("aes-128-cbc",key,bytes.subarray(0,16));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]));
    expect(version).toBe("1"); expect(data).toMatchObject({ dtrait: "fake-device-trait", path, sdkVersion: "1.0.0.381" });
    expect(directSecurityHeaders(session,path,{signed:false})["bd-ticket-guard-client-data"]).toBeUndefined();
  });
});
