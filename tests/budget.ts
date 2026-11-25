// Time budgets for tests that check that work stays bounded (damaged or hostile input: no runaway loop, no work
// multiplied by a count the file claims) and for the few speed checks.
//
// Measured as the CPU time of this test process (process.cpuUsage: user + system of every thread, worker threads and
// the libuv pool included), not the wall clock. vitest runs each test file in its own process (pool "forks"), one file
// at a time, so the CPU time is the work this test did. When several suites run at once on the PC (7 departments),
// the wall clock stretches with the load; CPU time hardly does (SMT and turbo cost a little: CPU_MARGIN).
// A loop that does not end, or work that grows 3x past the budget, still fails.
//
// OMW_TEST_SLOW=<n> multiplies every budget and timeout (slow PC, profiler, coverage run).
// (Windows counts CPU time in 15.6 ms ticks: budgets below ~200 ms should be checked as a mean over many calls.)

export const SLOW = Math.max(1, Number(process.env.OMW_TEST_SLOW) || 1);

/** CPU contention between processes (hyper-threads sharing a core, lower turbo clocks) */
const CPU_MARGIN = 2;

/** CPU milliseconds this process has used so far: take the difference of two calls */
export function cpuNow(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/** a CPU-time budget from the idle wall-clock milliseconds it replaced */
export const cpuBudget = (ms: number): number => ms * CPU_MARGIN * SLOW;

/** a test timeout (wall clock, so it does stretch with the PC's load): ms on an idle PC, times LOAD */
const LOAD = 3;
export const wallTimeout = (ms: number): number => ms * LOAD * SLOW;

/** a wall-clock budget, only for what waits on timers (a wait limit: CPU time does not see a wait that goes on) */
export const wallBudget = wallTimeout;
