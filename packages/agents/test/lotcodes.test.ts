import { describe, expect, it } from "vitest";
import { canonicalLot, lotDistance, matchLot } from "../src/lotcodes.ts";

describe("canonicalLot", () => {
  it("folds packer dash drift and zero padding onto one form", () => {
    expect(canonicalLot("PK-251014-7")).toBe("PK251014007");
    expect(canonicalLot("PK251014007")).toBe("PK251014007");
    expect(canonicalLot("pk 251014 007")).toBe("PK251014007");
  });

  it("strips a retail chain prefix and normalises case", () => {
    expect(canonicalLot("FRM:pk251014007")).toBe("PK251014007");
  });

  it("leaves grower lots in their own form", () => {
    expect(canonicalLot("gr3-25287-f2")).toBe("GR3-25287-F2");
  });
});

describe("matchLot", () => {
  it("is exact after canonicalisation", () => {
    expect(matchLot("PK251014007", "PK-251014-7")).toEqual({ kind: "exact", distance: 0 });
  });

  it("flags a one-character decoy as near, never as a match", () => {
    const m = matchLot("PK251014007", "PK251014001");
    expect(m.kind).toBe("near");
    expect(m.distance).toBe(1);
  });

  it("accepts a retail truncation only when it is an unambiguous prefix", () => {
    expect(matchLot("PK251014007", "FRM:PK25101400").kind).toBe("truncated");
    expect(matchLot("PK251014007", "FRM:PK25").kind).toBe("none");
  });

  it("calls unrelated codes none", () => {
    expect(matchLot("PK251014007", "GR3-25287-F2").kind).toBe("none");
    expect(lotDistance("ABC", "ABD")).toBe(1);
  });
});
