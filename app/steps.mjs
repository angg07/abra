// A step's time in its run: seconds since the run started, one decimal (the run page jumps the video there)
export const stamp = (step, started, now = Date.now()) => ({ ...step, at: Math.max(0, Math.round((now - started) / 100) / 10) });
