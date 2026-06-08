// Netgsm SMS helper module

export function formatSMSNumber(phone) {
  if (!phone) return null;
  // Keep only digits
  let cleaned = phone.replace(/\D/g, "");
  
  if (cleaned.startsWith("00")) {
    cleaned = cleaned.substring(2);
  }
  
  // Netgsm XML API accepts standard Turkish 10-digit format: "5XXXXXXXXX" (without country code 90 or leading 0)
  if (cleaned.startsWith("90")) {
    cleaned = cleaned.substring(2);
  }
  
  if (cleaned.startsWith("0")) {
    cleaned = cleaned.substring(1);
  }
  
  return cleaned;
}

export async function sendSMS(phone, message, env) {
  const usercode = env.NETGSM_USERCODE;
  const password = env.NETGSM_PASSWORD;
  const msgheader = env.NETGSM_HEADER;

  if (!usercode || !password || !msgheader) {
    console.log(`[SMS Simüle Gönderim] (Env Değişkenleri Eksik)
Alıcı: ${phone}
Mesaj: ${message}`);
    return { success: true, simulated: true, reason: "Missing Netgsm configurations" };
  }

  const cleanedPhone = formatSMSNumber(phone);
  if (!cleanedPhone || cleanedPhone.length !== 10) {
    return { success: false, error: "Invalid Turkish phone number for SMS (must be 10 digits)" };
  }

  // XML Payload format requested by Netgsm
  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<mainbody>
    <header>
        <company dil="TR">Netgsm</company>
        <usercode>${usercode}</usercode>
        <password>${password}</password>
        <startdate></startdate>
        <stopdate></stopdate>
        <type>1:n</type>
        <msgheader>${msgheader}</msgheader>
    </header>
    <body>
        <msg><![CDATA[${message}]]></msg>
        <no>${cleanedPhone}</no>
    </body>
</mainbody>`;

  const url = "https://api.netgsm.com.tr/sms/send/xml";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml"
      },
      body: xmlPayload
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Netgsm API Hatası] Durum: ${res.status}, Yanıt: ${errText}`);
      return { success: false, status: res.status, error: errText };
    }

    const responseText = await res.text();
    // Netgsm returns response like "00 173772153426" if successful, or error code like "30", "40", etc.
    const code = responseText.substring(0, 2);
    if (code === "00") {
      const jobId = responseText.substring(3).trim();
      console.log(`[Netgsm SMS API Başarılı] Alıcı: ${cleanedPhone}, JobID: ${jobId}`);
      return { success: true, jobId };
    } else {
      console.error(`[Netgsm SMS API Hatası Kodu: ${code}] Yanıt: ${responseText}`);
      return { success: false, errorCode: code, error: responseText };
    }
  } catch (err) {
    console.error(`[Netgsm SMS API Çökme Hatası]:`, err);
    return { success: false, error: err.message };
  }
}
