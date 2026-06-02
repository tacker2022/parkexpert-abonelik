// WhatsApp helper module for Green API

export function formatWhatsAppNumber(phone) {
  if (!phone) return null;
  // Keep only digits
  let cleaned = phone.replace(/\D/g, "");
  
  if (cleaned.startsWith("00")) {
    cleaned = cleaned.substring(2);
  }
  
  // Replace leading 0 with country code 90 (Turkey)
  if (cleaned.startsWith("0")) {
    cleaned = "90" + cleaned.substring(1);
  }
  
  // Prepend 90 if it's a 10 digit number (standard mobile number without country code)
  if (!cleaned.startsWith("90") && cleaned.length === 10) {
    cleaned = "90" + cleaned;
  }
  
  return `${cleaned}@c.us`;
}

export async function sendWhatsApp(phone, message, env) {
  const instanceId = env.GREENAPI_INSTANCE_ID;
  const apiToken = env.GREENAPI_API_TOKEN;

  if (!instanceId || !apiToken) {
    console.log(`[WhatsApp Simüle Gönderim] (Env Değişkenleri Eksik)
Alıcı: ${phone}
Mesaj: ${message}`);
    return { success: true, simulated: true, reason: "Missing Green API configurations" };
  }

  const chatId = formatWhatsAppNumber(phone);
  if (!chatId) {
    return { success: false, error: "Invalid phone number" };
  }

  const url = `https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chatId: chatId,
        message: message
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[WhatsApp API Hatası] Durum: ${res.status}, Yanıt: ${errText}`);
      return { success: false, status: res.status, error: errText };
    }

    const data = await res.json();
    console.log(`[WhatsApp API Başarılı] Alıcı: ${chatId}, MesajID: ${data.idMessage || "N/A"}`);
    return { success: true, data };
  } catch (err) {
    console.error(`[WhatsApp API Çökme Hatası]:`, err);
    return { success: false, error: err.message };
  }
}
