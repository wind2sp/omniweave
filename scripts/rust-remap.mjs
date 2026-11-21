// Keep the build machine's folders out of omniweave.exe. Rust writes source paths into the binary (panic locations of
// the crates in the cargo registry, the checkout), and on Windows those start with C:\Users\<account>\…. The flags map
// the cargo home, the rustup home and the checkout to fixed words; release.yml does the same on the CI runner.
//
//   import { remapEnv } from "./rust-remap.mjs";  execFileSync("npx", ["tauri", "build"], { env: remapEnv() })
//   node scripts/rust-remap.mjs                     prints the CARGO_ENCODED_RUSTFLAGS value (for a shell)
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function remapFlags(env = process.env, root = resolve(fileURLToPath(import.meta.url), "../..")) {
  const cargo = env.CARGO_HOME || join(homedir(), ".cargo");
  const rustup = env.RUSTUP_HOME || join(homedir(), ".rustup");
  return [`--remap-path-prefix=${cargo}=/cargo`, `--remap-path-prefix=${rustup}=/rustup`, `--remap-path-prefix=${root}=/omniweave`];
}

/** the environment for `tauri build` / `cargo build`, with the flags added to any already set */
export function remapEnv(env = process.env) {
  const have = env.CARGO_ENCODED_RUSTFLAGS ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f") : [];
  return { ...env, CARGO_ENCODED_RUSTFLAGS: [...have, ...remapFlags(env)].join("\x1f") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(remapEnv().CARGO_ENCODED_RUSTFLAGS);
