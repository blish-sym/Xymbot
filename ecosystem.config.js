// PM2 Ecosystem Config - For VPS deployments
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'Xymbot',
      script: 'index.js',
      interpreter: 'node',
      watch: false,
      ignore_watch: ['node_modules', 'session', 'tmp', 'database'],
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 50,
      env: {
        NODE_ENV: 'production',
        // Add your SESSION_ID here if running on a VPS without a .env file
        // SESSION_ID: 'XYMBOT~your_base64_session_here',
      }
    }
  ]
};
