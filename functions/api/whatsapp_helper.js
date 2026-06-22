// WhatsApp helper module for Green API & Meta Cloud API

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
  
  return cleaned;
}

export async function sendWhatsApp(phone, message, env) {
  // 1. Check if Meta Cloud API credentials are set
  const metaToken = env.WHATSAPP_API_TOKEN;
  const metaPhoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  const metaTemplateName = env.WHATSAPP_TEMPLATE_NAME || "parkexpert_notification";

  if (metaToken && metaPhoneId) {
    // USE META OFFICIAL CLOUD API
    const formattedPhone = formatWhatsAppNumber(phone);
    if (!formattedPhone) {
      return { success: false, error: "Invalid phone number" };
    }

    const url = `https://graph.facebook.com/v18.0/${metaPhoneId}/messages`;
    
    // Build payload for Option A (Generic Template with 1 variable)
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formattedPhone,
      type: "template",
      template: {
        name: metaTemplateName,
        language: {
          code: "tr"
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: message
              }
            ]
          }
        ]
      }
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${metaToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[WhatsApp Meta API Hatası] Durum: ${res.status}, Yanıt: ${errText}`);
        return { success: false, status: res.status, error: errText };
      }

      const data = await res.json();
      console.log(`[WhatsApp Meta API Başarılı] Alıcı: ${formattedPhone}, MessageID: ${data.messages?.[0]?.id || "N/A"}`);
      return { success: true, data };
    } catch (err) {
      console.error(`[WhatsApp Meta API Çökme Hatası]:`, err);
      return { success: false, error: err.message };
    }
  }

  // 2. Fallback to Green API if credentials are set
  const greenInstanceId = env.GREENAPI_INSTANCE_ID;
  const greenApiToken = env.GREENAPI_API_TOKEN;

  if (greenInstanceId && greenApiToken) {
    const formattedPhone = formatWhatsAppNumber(phone);
    if (!formattedPhone) {
      return { success: false, error: "Invalid phone number" };
    }
    const chatId = `${formattedPhone}@c.us`;

    const apiHost = env.GREENAPI_API_URL || "https://api.green-api.com";
    const url = `${apiHost.replace(/\/+$/, "")}/waInstance${greenInstanceId}/sendMessage/${greenApiToken}`;

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
        console.error(`[WhatsApp Green API Hatası] Durum: ${res.status}, Yanıt: ${errText}`);
        return { success: false, status: res.status, error: errText };
      }

      const data = await res.json();
      console.log(`[WhatsApp Green API Başarılı] Alıcı: ${chatId}, MesajID: ${data.idMessage || "N/A"}`);
      return { success: true, data };
    } catch (err) {
      console.error(`[WhatsApp Green API Çökme Hatası]:`, err);
      return { success: false, error: err.message };
    }
  }

  // 3. Simulated send if no API is configured
  console.log(`[WhatsApp Simüle Gönderim] (Hiçbir API Yapılandırılmamış)
Alıcı: ${phone}
Mesaj: ${message}`);
  return { success: true, simulated: true, reason: "No WhatsApp API configuration found" };
}
