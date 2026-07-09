module.exports = {
  apps: [
    {
      name: "contribution-worker",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // A restart re-runs the sweep immediately; $max upserts make that safe.
      restart_delay: 30000,
      max_memory_restart: "300M",
      time: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
