// ============================================================
// lib/telegram.js - Telegram Alert Notifications
// Sends a text message to a Telegram chat via the Bot API.
// If the bot token or chat ID is not set, it does nothing
// (Telegram alerts are optional / opt-in).
// ============================================================

/**
 * Sends a message to the configured Telegram chat.
 * Fails silently — a Telegram failure should never crash the main flow.
 *
 * @param {string} message - The text to send (supports Markdown)
 */
async function sendTelegramAlert(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // If either value is missing, Telegram is not configured — skip silently
  if (!token || !chatId) return;

  try {
    // Telegram Bot API endpoint for sending messages
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       message,
        parse_mode: 'Markdown', // allows *bold* and `code` in messages
      }),
    });

    if (!response.ok) {
      // Log the failure but don't throw — keep it non-fatal
      const body = await response.text();
      console.warn('⚠️  Telegram alert failed:', response.status, body);
    }
  } catch (err) {
    // Network errors, DNS failures, etc. — log and continue
    console.warn('⚠️  Telegram alert error:', err.message);
  }
}

module.exports = { sendTelegramAlert };
