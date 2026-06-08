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

export function formatDateForNetgsm(date) {
  if (!date) return "";
  let d = date;
  if (typeof date === "string") {
    d = new Date(date);
  }
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";

  // Convert to Turkey Time (UTC+3)
  const turkeyTime = new Date(d.getTime() + (3 * 60 * 60 * 1000));
  
  const day = String(turkeyTime.getUTCDate()).padStart(2, '0');
  const month = String(turkeyTime.getUTCMonth() + 1).padStart(2, '0');
  const year = String(turkeyTime.getUTCFullYear());
  const hours = String(turkeyTime.getUTCHours()).padStart(2, '0');
  const minutes = String(turkeyTime.getUTCMinutes()).padStart(2, '0');
  
  return `${day}${month}${year}${hours}${minutes}`; // ddMMyyyyHHmm
}

async function logSMSToSupabase(phone, message, env, jobId, status, scheduledDate) {
  const supabaseUrl = env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn("[logSMSToSupabase] Supabase config missing, skipping DB logging");
    return;
  }

  try {
    const dbPayload = {
      job_id: jobId || null,
      phone: phone,
      message: message,
      status: status || "Beklemede",
      scheduled_at: scheduledDate || null,
      created_at: new Date().toISOString()
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/sms_logs`, {
      method: "POST",
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(dbPayload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[logSMSToSupabase Error] ${res.status}: ${errText}`);
    }
  } catch (err) {
    console.error("[logSMSToSupabase Exception]", err);
  }
}

export async function sendSMS(phone, message, env, scheduledDate, flashSms) {
  const usercode = env.NETGSM_USERCODE;
  const password = env.NETGSM_PASSWORD;
  const msgheader = env.NETGSM_HEADER;

  if (!usercode || !password || !msgheader) {
    console.log(`[SMS Simüle Gönderim] (Env Değişkenleri Eksik)
Alıcı: ${phone}
Mesaj: ${message}
Planlanan Tarih: ${scheduledDate || 'Hemen'}
Flash SMS: ${flashSms ? 'Evet' : 'Hayır'}`);
    
    // Log simulated SMS
    const mockJobId = "SIM-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    const simStatus = "Simüle Edildi" + (flashSms ? " (Flash)" : "");
    await logSMSToSupabase(phone, message, env, mockJobId, simStatus, scheduledDate);

    return { success: true, simulated: true, reason: "Missing Netgsm configurations" };
  }

  const cleanedPhone = formatSMSNumber(phone);
  if (!cleanedPhone || cleanedPhone.length !== 10) {
    return { success: false, error: "Invalid Turkish phone number for SMS (must be 10 digits)" };
  }

  const startdateValue = formatDateForNetgsm(scheduledDate);
  const flashSmsValue = flashSms ? "1" : "0";

  // XML Payload format requested by Netgsm
  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<mainbody>
    <header>
        <company dil="TR">Netgsm</company>
        <usercode>${usercode}</usercode>
        <password>${password}</password>
        <startdate>${startdateValue}</startdate>
        <stopdate></stopdate>
        <type>1:n</type>
        <msgheader>${msgheader}</msgheader>
        <flashsms>${flashSmsValue}</flashsms>
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
      await logSMSToSupabase(cleanedPhone, message, env, null, `Hata: HTTP ${res.status}`, scheduledDate);
      return { success: false, status: res.status, error: errText };
    }

    const responseText = await res.text();
    // Netgsm returns response like "00 173772153426" if successful, or error code like "30", "40", etc.
    const code = responseText.substring(0, 2);
    if (code === "00") {
      const jobId = responseText.substring(3).trim();
      console.log(`[Netgsm SMS API Başarılı] Alıcı: ${cleanedPhone}, JobID: ${jobId}`);
      
      const initStatus = (scheduledDate ? "Zamanlandı" : "Gönderildi") + (flashSms ? " (Flash)" : "");
      await logSMSToSupabase(cleanedPhone, message, env, jobId, initStatus, scheduledDate);

      return { success: true, jobId };
    } else {
      console.error(`[Netgsm SMS API Hatası Kodu: ${code}] Yanıt: ${responseText}`);
      await logSMSToSupabase(cleanedPhone, message, env, null, `Hata: Kod ${code}`, scheduledDate);
      return { success: false, errorCode: code, error: responseText };
    }
  } catch (err) {
    console.error(`[Netgsm SMS API Çökme Hatası]:`, err);
    await logSMSToSupabase(cleanedPhone || phone, message, env, null, "Hata: Bağlantı Hatası", scheduledDate);
    return { success: false, error: err.message };
  }
}
