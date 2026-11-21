// Update check after a failure, and what the installer passes to the restarted app (docs/RELEASING.md
// "업데이트 확인 실패").
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RETRY_MS, retryDelay } from "../src/ui/shell/updateRetry";

describe("update check retry", () => {
  it("retries a failed silent check after 30 s, then 10 min, then waits for the 6-hour period", () => {
    expect(retryDelay(0)).toBeNull();
    expect(retryDelay(1)).toBe(30_000);
    expect(retryDelay(2)).toBe(10 * 60_000);
    expect(retryDelay(3)).toBeNull();
    expect(RETRY_MS.every((ms) => ms < 6 * 60 * 60 * 1000)).toBe(true);
  });

  it("UpdateBanner schedules the retry and logs why the check failed", () => {
    const src = readFileSync("src/ui/shell/UpdateBanner.tsx", "utf8");
    expect(src).toMatch(/retryDelay\(\+\+failures\)/);
    expect(src).toMatch(/invoke<string>\("update_diag"\)/);
    expect(src).toMatch(/clearTimeout\(retry\)/);
    expect(readFileSync("src-tauri/src/lib.rs", "utf8")).toMatch(/update_diag, update_test_mode/);
  });

  it("the installer restarts a --update-test run as a normal launch", () => {
    const nsi = readFileSync("src-tauri/windows/installer.nsi", "utf8");
    const onSuccess = nsi.slice(nsi.indexOf("Function .onInstSuccess"), nsi.indexOf("FunctionEnd", nsi.indexOf("Function .onInstSuccess")));
    expect(onSuccess).toMatch(/\$\{WordReplace\} \$R0 "--update-test" "" "\+" \$R0/);
    expect(onSuccess.indexOf("WordReplace")).toBeLessThan(onSuccess.indexOf("RunAsUser"));
  });
});
