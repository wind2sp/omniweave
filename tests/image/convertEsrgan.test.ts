// scripts/convert-esrgan.mjs reads PyTorch .pth files without Python: its pickle reader must accept a state dict and
// nothing else — no globals beyond the four allowed, no calls, no code-running opcodes, no reads past the end, no
// tensor outside its storage, and no endless loop on a damaged file.
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script without types
import { readPth, readStateDict } from "../../scripts/convert-esrgan.mjs";

const enc = new TextEncoder();
const op = {
  proto: (v: number) => [0x80, v],
  mark: () => [0x28],
  str: (s: string) => {
    const b = enc.encode(s);
    return [0x8c, b.length, ...b];
  },
  int: (v: number) => [0x4b, v],
  global: (m: string, n: string) => [0x63, ...enc.encode(m + "\n" + n + "\n")],
  stackGlobal: (m: string, n: string) => [...op.str(m), ...op.str(n), 0x93],
  emptyTuple: () => [0x29],
  tuple: () => [0x74],
  tuple2: () => [0x86],
  reduce: () => [0x52],
  persid: () => [0x51],
  setitems: () => [0x75],
  stop: () => [0x2e],
  false: () => [0x89],
};

/** OrderedDict({ w: tensor(size, stride, offset) over storage "0" of `numel` floats }). */
function statePickle(size = [2, 2], stride = [2, 1], offset = 0, numel = 4): Uint8Array {
  return new Uint8Array([
    ...op.proto(2),
    ...op.global("collections", "OrderedDict"), ...op.emptyTuple(), ...op.reduce(),
    ...op.mark(),
    ...op.str("w"),
    ...op.global("torch._utils", "_rebuild_tensor_v2"),
    ...op.mark(),
    ...op.mark(), ...op.str("storage"), ...op.global("torch", "FloatStorage"), ...op.str("0"), ...op.str("cpu"), ...op.int(numel), ...op.tuple(), ...op.persid(),
    ...op.int(offset),
    ...op.int(size[0]), ...op.int(size[1]), ...op.tuple2(),
    ...op.int(stride[0]), ...op.int(stride[1]), ...op.tuple2(),
    ...op.false(),
    ...op.global("collections", "OrderedDict"), ...op.emptyTuple(), ...op.reduce(),
    ...op.tuple(), ...op.reduce(),
    ...op.setitems(),
    ...op.stop(),
  ]);
}

const pth = (pkl: Uint8Array, storage: Uint8Array) => zipSync({ "archive/data.pkl": pkl, "archive/data/0": storage }, { level: 0 });

describe("convert-esrgan pickle reader", () => {
  it("reads a state dict and its tensor", () => {
    const d = readStateDict(statePickle());
    expect(d.get("w")).toMatchObject({ key: "0", dtype: "f32", offset: 0, size: [2, 2], stride: [2, 1] });
    const t = readPth(pth(statePickle(), new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer))).get("w");
    expect(Array.from(t.data)).toEqual([1, 2, 3, 4]);
  });

  it("refuses other globals (GLOBAL and STACK_GLOBAL) and calls of allowed ones", () => {
    const run = (b: number[]) => () => readStateDict(new Uint8Array([...op.proto(2), ...b, ...op.stop()]));
    expect(run([...op.global("os", "system"), ...op.str("echo"), 0x85, ...op.reduce()])).toThrow(/global not allowed: os system/);
    expect(run([...op.global("builtins", "eval")])).toThrow(/global not allowed/);
    expect(run([...op.stackGlobal("subprocess", "Popen")])).toThrow(/global not allowed: subprocess Popen/);
    expect(run([...op.stackGlobal("posix", "system")])).toThrow(/global not allowed/);
    expect(run([...op.global("torch", "FloatStorage"), ...op.emptyTuple(), ...op.reduce()])).toThrow(/call not allowed/);
    expect(run([...op.global("collections", "OrderedDict"), ...op.str("x"), 0x85, ...op.reduce()])).toThrow(/OrderedDict with arguments/);
  });

  it("refuses code-running and unknown opcodes", () => {
    // INST, OBJ, NEWOBJ, NEWOBJ_EX, EXT1, PERSID (text), READONLY_BUFFER, unknown
    for (const code of [0x69, 0x6f, 0x81, 0x92, 0x82, 0x50, 0x98, 0xff]) expect(() => readStateDict(new Uint8Array([0x80, 2, code, 0x2e]))).toThrow(/opcode not allowed/);
  });

  it("bounds: truncated data, a GLOBAL without its line end (no endless loop), bad stack use", () => {
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x58, 0xff, 0xff, 0xff, 0x7f, 0x61]))).toThrow(/truncated/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x8c, 10, 0x41]))).toThrow(/truncated/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x4a, 1, 2]))).toThrow(/truncated/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x63, 0x6f, 0x73]))).toThrow(/GLOBAL line/);
    expect(() => readStateDict(new Uint8Array([0x80, 2]))).toThrow(/no STOP/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x61, 0x2e]))).toThrow(/underflow/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x65, 0x2e]))).toThrow(/no MARK/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x68, 7, 0x2e]))).toThrow(/memo 7/);
    // APPEND into a tuple, SETITEM on a list, a value left over
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x29, 0x4b, 1, 0x61, 0x2e]))).toThrow(/not a list/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x5d, ...op.str("k"), 0x4b, 1, 0x73, 0x2e]))).toThrow(/not a dict/);
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x4b, 1, 0x4b, 2, 0x2e]))).toThrow(/left on the stack/);
    // BUILD with anything but torch's _metadata
    expect(() => readStateDict(new Uint8Array([0x80, 2, 0x7d, 0x7d, ...op.str("__class__"), 0x4b, 1, 0x73, 0x62, 0x2e]))).toThrow(/BUILD not allowed/);
  });

  it("tensors must lie inside their storage (descriptor and file)", () => {
    expect(() => readStateDict(statePickle([2, 2], [2, 1], 1, 4))).toThrow(/outside its storage/);
    expect(() => readStateDict(statePickle([200, 200], [200, 1], 0, 100))).toThrow(/outside its storage/);
    // the storage file is shorter than the pickle says
    expect(() => readPth(pth(statePickle(), new Uint8Array(8)))).toThrow(/outside its storage file/);
    expect(() => readPth(zipSync({ "x.txt": new Uint8Array(1) }))).toThrow(/not a torch zip/);
  });
});
