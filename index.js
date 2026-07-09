require("dotenv").config();
const { runSweep } = require("./sweep");

const quantumUri = process.env.MONGO_URI_QUANTUM;
const rankingUri = process.env.MONGO_RANKING_URI;

if (!quantumUri || !rankingUri) {
  console.error(
    "Missing env vars: MONGO_URI_QUANTUM and MONGO_RANKING_URI are required."
  );
  process.exit(1);
}

const intervalHours = Number(process.env.SWEEP_INTERVAL_HOURS) || 24;
const runOnce = process.argv.includes("--once");

let sweeping = false;

const sweep = async () => {
  if (sweeping) {
    console.log("[worker] previous sweep still running, skipping this tick");
    return;
  }
  sweeping = true;
  try {
    await runSweep({ quantumUri, rankingUri });
  } catch (err) {
    console.error("[worker] sweep failed:", err.message);
  } finally {
    sweeping = false;
  }
};

(async () => {
  await sweep();

  if (runOnce) {
    process.exit(0);
  }

  console.log(`[worker] next sweep in ${intervalHours}h`);
  setInterval(() => {
    sweep().then(() => console.log(`[worker] next sweep in ${intervalHours}h`));
  }, intervalHours * 60 * 60 * 1000);
})();
