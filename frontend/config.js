// ============================================================
// config.js - Global Application Configuration
// ============================================================
// Student note: Change API_BASE_URL to your deployed Render backend URL
// before deploying to Netlify or another static hosting service.
// Example: 'https://drainguard-backend.onrender.com'
// ============================================================

window.APP_CONFIG = {
  API_BASE_URL: 'http://localhost:3001', // Change this for production
  POLL_INTERVAL_MS: 5000,               // How often the overview tab polls for new data
  IST_TIMEZONE: 'Asia/Kolkata'           // All times shown in Indian Standard Time
};
