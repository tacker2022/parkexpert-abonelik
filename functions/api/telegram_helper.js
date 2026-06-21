export async function sendTelegramAlert(message, env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log("[Telegram Alert Simüle]:\n", message);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[Telegram Alert Response Error]:", err);
    }
  } catch (err) {
    console.error("[Telegram Alert Exception Error]:", err);
  }
}
