import path from "node:path";
import { describe, expect, it } from "vitest";
import { assetPath, contentType } from "../serve";

/** Which file of the web build answers a request on `app://garage/`, and nothing outside it. */
const WEB = path.resolve("/app/web");
const index = path.join(WEB, "index.html");
const at = (p: string) => assetPath(WEB, `app://garage${p}`);

describe("assetPath", () => {
  it("serves the build's own files", () => {
    expect(at("/assets/index-abc.js")).toBe(path.join(WEB, "assets", "index-abc.js"));
    expect(at("/favicon.svg")).toBe(path.join(WEB, "favicon.svg"));
  });

  it("answers a tool's path, and the root, with the app's page", () => {
    expect(at("/")).toBe(index);
    expect(at("/media-bin")).toBe(index);
  });

  it("decodes the path, so a name with a space is found", () => {
    expect(at("/assets/a%20b.js")).toBe(path.join(WEB, "assets", "a b.js"));
  });

  it("never serves anything outside the build", () => {
    // Plain and encoded dots both resolve against the build's own root, so
    // however a path climbs, it lands inside the build.
    for (const climb of ["/../secret.js", "/assets/%2e%2e/%2e%2e/secret.js", "/assets/%2e%2e%2f%2e%2e%2fsecret.js", "/assets/..%5c..%5csecret.js"]) {
      expect(at(climb).startsWith(WEB + path.sep), climb).toBe(true);
    }
    expect(at("/x%00.js")).toBe(index);
    // A name that only starts with two dots is an ordinary file.
    expect(at("/..notes.js")).toBe(path.join(WEB, "..notes.js"));
  });

  it("answers a malformed escape with the app's page", () => {
    expect(at("/%E0%A4%A.js")).toBe(index);
  });
});

describe("contentType", () => {
  it("names the types the build holds, whatever the case", () => {
    expect(contentType("a.html")).toBe("text/html; charset=utf-8");
    expect(contentType("a.JS")).toBe("text/javascript; charset=utf-8");
    expect(contentType("a.unknown")).toBe("application/octet-stream");
  });
});
