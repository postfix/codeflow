import { closeSync, constants, fchmodSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flockSync } from "fs-ext";
import { assertContainedPath } from "./artifacts.js";

export interface OwnershipLease {
  release(): void;
}

export async function acquireOwnership(workspace: string): Promise<OwnershipLease> {
  const stateDirectory = join(workspace, ".coding-flow");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await assertContainedPath(workspace, stateDirectory);
  const descriptor = openSync(
    join(stateDirectory, "lock"),
    constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    flockSync(descriptor, "exnb");
  } catch {
    closeSync(descriptor);
    throw new Error("WORKSPACE_BUSY");
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      flockSync(descriptor, "un");
      closeSync(descriptor);
    },
  };
}
