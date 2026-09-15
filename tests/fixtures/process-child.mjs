import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

async function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  let moved = false;
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    moved = true;
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!moved) await unlink(temporary).catch(() => {});
    throw error;
  }
}

const [mode, path, ...values] = process.argv.slice(2);

if (mode === "record") {
  let count = 0;
  try { count = Number(await readFile(path, "utf8")); } catch {}
  await writeFile(path, String(count + 1));
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(values), (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => process.stderr.write("recorded", (error) => error ? reject(error) : resolve()));
} else if (mode === "hang") {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "grandchild", path], {
    stdio: "inherit",
  });
  await writeFile(path, String(child.pid));
  setInterval(() => {}, 1_000);
} else if (mode === "grandchild") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else if (mode === "qualification-hang") {
  const nonce = values[0];
  const markerMode = values[1] ?? "atomic";
  if (!nonce) throw new Error("qualification nonce is required");
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "qualification-grandchild", nonce], {
    stdio: "ignore",
  });
  if (markerMode === "incomplete") {
    await writeAtomic(`${path}.pid`, String(process.pid));
    await writeAtomic(path, "{");
  } else {
    await writeAtomic(path, JSON.stringify({ pid: process.pid, childPid: child.pid, nonce }));
  }
  setInterval(() => {}, 1_000);
} else if (mode === "qualification-grandchild") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "resistant") {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "ignore-term"], {
    stdio: "ignore",
  });
  child.unref();
  await writeFile(path, String(child.pid));
} else if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "output") {
  await new Promise((resolve, reject) => process.stdout.write("x".repeat(Number(path)), (error) => error ? reject(error) : resolve()));
} else if (mode === "resistant-output") {
  process.on("SIGTERM", () => {});
  const chunk = Buffer.alloc(1024 * 1024, 0x78);
  while (true) await new Promise((resolve, reject) => process.stdout.write(chunk, (error) => error ? reject(error) : resolve()));
} else if (mode === "inherited-output") {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "resistant-output"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.unref();
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "dual-utf8") {
  const chunk = Buffer.from("€".repeat(21_845) + "x");
  for (let index = 0; index < 512; index += 1) {
    await Promise.all([
      new Promise((resolve, reject) => process.stdout.write(chunk, (error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => process.stderr.write(chunk, (error) => error ? reject(error) : resolve())),
    ]);
  }
  const remainder = Buffer.from("€".repeat(10_922) + "xx");
  await Promise.all([
    new Promise((resolve, reject) => process.stdout.write(remainder, (error) => error ? reject(error) : resolve())),
    new Promise((resolve, reject) => process.stderr.write(remainder, (error) => error ? reject(error) : resolve())),
  ]);
} else if (/^[0-9a-f-]{36}$/.test(mode)) {
  if (process.env.CODEFLOW_TEST_RUNNER_PID) await writeFile(process.env.CODEFLOW_TEST_RUNNER_PID, String(process.pid));
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
