module.exports = {
  apps: [
    {
      name: "contribution-worker",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      // Node's own DNS resolver can prefer IPv6 and fail with ECONNREFUSED
      // resolving the mongodb+srv:// SRV record on networks where IPv6 is
      // advertised but doesn't actually route — even though plain OS tools
      // (nslookup) fall back to IPv4 transparently and succeed on the same
      // query. This forces Node to prefer IPv4, matching what system DNS
      // resolution already does. Confirmed as the failure mode 2026-07-31:
      // production crash-looped for ~3 days on "querySrv ECONNREFUSED
      // _mongodb._tcp.cluster0.t0xz84v.mongodb.net" while nslookup for the
      // identical record succeeded from both the router's resolver and 8.8.8.8.
      node_args: "--dns-result-order=ipv4first",
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
