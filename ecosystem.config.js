// PM2 process manager configuration
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'wows-reporter',
      script: 'dist/index.js',
      cwd: __dirname,
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
