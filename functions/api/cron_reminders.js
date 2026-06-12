import { sendSMS } from "./sms_helper.js";
import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";

// Helper to replace template variables
function resolveTemplate(template, vars) {
  if (!template) return "";
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    const regex = new RegExp(`\\{${key}\\}`, "g");
    result = result.replace(regex, val || "");
  }
  return result;
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const cronSecret = context.env.CRON_SECRET || "parkexpert-cron-secret-key-998877";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  // 1. Verify Authorization (secure trigger)
  const authHeader = context.request.headers.get("Authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized cron trigger. Invalid or missing secret." }), { status: 401, headers });
  }

  try {
    // 2. Fetch system settings
    const settingsRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.notification_toggles&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    if (!settingsRes.ok) {
      throw new Error(`Failed to load system settings: ${settingsRes.status}`);
    }

    const rows = await settingsRes.json();
    if (rows.length === 0 || !rows[0].value?.auto_reminders_enabled) {
      return new Response(JSON.stringify({ success: true, message: "Auto reminders are disabled in settings." }), { status: 200, headers });
    }

    const settings = rows[0].value;
    const channel = settings.auto_reminders_channel || "sms";
    const daysStr = settings.auto_reminders_days || "7,3,1,0";
    const reminderDays = daysStr.split(",").map(d => parseInt(d.trim())).filter(d => !isNaN(d));

    // 3. Fetch all otoparks in memory to resolve variables
    const otoparksRes = await fetch(`${supabaseUrl}/rest/v1/otoparks`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const otoparks = otoparksRes.ok ? await otoparksRes.json() : [];

    const executionResults = [];

    // 4. Process reminders for each configured day
    for (const daysLeft of reminderDays) {
      // Calculate date range for target day in UTC
      const startRange = new Date();
      startRange.setUTCHours(0, 0, 0, 0);
      startRange.setUTCDate(startRange.getUTCDate() + daysLeft);

      const endRange = new Date(startRange);
      endRange.setUTCDate(endRange.getUTCDate() + 1);

      const startIso = startRange.toISOString();
      const endIso = endRange.toISOString();

      // Query approved applications expiring in this date range
      const queryUrl = `${supabaseUrl}/rest/v1/applications?status=eq.Onaylandı&subscription_expires_at=gte.${startIso}&subscription_expires_at=lt.${endIso}&select=*`;
      const appRes = await fetch(queryUrl, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!appRes.ok) {
        executionResults.push({ daysLeft, success: false, error: `Query failed: ${appRes.status}` });
        continue;
      }

      const expiringApps = await appRes.json();
      const processedCount = expiringApps.length;
      let successCount = 0;
      let failCount = 0;
      const errors = [];

      // Fetch template based on days remaining
      let template = "";
      if (daysLeft === 7) template = settings.auto_reminders_template_7d;
      else if (daysLeft === 3) template = settings.auto_reminders_template_3d;
      else if (daysLeft === 1) template = settings.auto_reminders_template_1d;
      else if (daysLeft === 0) template = settings.auto_reminders_template_0d;

      // Fallback templates if empty
      if (!template) {
        if (daysLeft === 0) {
          template = "Sayın {fullName}, {appLocation} otopark aboneliğiniz bugün dolmuştur. Plaka tanıma sisteminiz deaktif edilmiştir. Plakanız: {plateNumber}. PARKEXPERT";
        } else {
          template = `Sayın {fullName}, {appLocation} otopark aboneliğiniz ${daysLeft} gün sonra dolacaktır. Yenilemek için lütfen ödemenizi yapıp dekontunuzu sisteme yükleyiniz. PARKEXPERT`;
        }
      }

      for (const app of expiringApps) {
        try {
          const park = otoparks.find(p => p.name === app.parking_location) || {};
          const isBirlikSanayi = app.parking_location === "Birlik Sanayi Sitesi - Beylikdüzü";
          const isKurumsal = app.subscription_type && app.subscription_type.includes('Kurumsal') && !isBirlikSanayi;
          const price = isKurumsal 
            ? (park.price_external || "2400 TL") 
            : (park.price_employee || "1200 TL");

          const templateVars = {
            fullName: app.full_name,
            plateNumber: app.plate_number,
            appLocation: app.parking_location,
            expiryDate: new Date(app.subscription_expires_at).toLocaleDateString('tr-TR'),
            remainingDays: daysLeft,
            bankName: park.bank_name || "Vakıfbank",
            iban: park.iban || "",
            companyTitle: park.company_title || "PARKEXPERT",
            price: price,
            supportPhone: park.support_phone || "0216 504 47 22"
          };

          const msgText = resolveTemplate(template, templateVars);
          let sentEmailSuccess = false;
          let sentWASuccess = false;
          let sentSMSSuccess = false;

          // Dispatch based on channel routing
          if (channel === "email" || channel === "omnichannel") {
            try {
              if (app.email) {
                await sendEmail({
                  to: app.email,
                  subject: `${app.parking_location} Otopark Aboneliği Süre Hatırlatması 🚗`,
                  html: `
                    <div style="font-family: sans-serif; padding: 1.5rem; color: #334155; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 8px;">
                      <h2 style="color: #0f3ba2; margin-top: 0; font-size: 1.25rem;">Abonelik Hatırlatma Bildirimi</h2>
                      <p style="font-size: 0.95rem; line-height: 1.6; color: #334155;">${msgText.replace(/\n/g, "<br>")}</p>
                      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 1.5rem 0;" />
                      <div style="font-size: 0.8rem; color: #64748b;">
                        Bu e-posta <strong>PARKEXPERT</strong> akıllı otopark yönetim sistemi tarafından otomatik olarak gönderilmiştir.
                      </div>
                    </div>
                  `,
                  env: context.env
                });
                sentEmailSuccess = true;
              }
            } catch (mailErr) {
              console.error(`[Cron Reminder Mail Error] ${app.phone}:`, mailErr);
            }
          }

          if (channel === "whatsapp" || channel === "omnichannel") {
            try {
              const waRes = await sendWhatsApp(app.phone, msgText, context.env);
              if (waRes.success !== false) sentWASuccess = true;
            } catch (waErr) {
              console.error(`[Cron Reminder WA Error] ${app.phone}:`, waErr);
            }
          }

          if (channel === "sms" || channel === "omnichannel") {
            try {
              const smsRes = await sendSMS(app.phone, msgText, context.env, null, false, "0", app.parking_location);
              if (smsRes.success) sentSMSSuccess = true;
            } catch (smsErr) {
              console.error(`[Cron Reminder SMS Error] ${app.phone}:`, smsErr);
            }
          }

          // We count it as success if at least one selected channel sent the notification
          if (channel === "omnichannel") {
            if (sentEmailSuccess || sentWASuccess || sentSMSSuccess) {
              successCount++;
            } else {
              failCount++;
              errors.push(`${app.phone}: Tüm kanallardan gönderim başarısız.`);
            }
          } else {
            const expectedSuccess = (channel === "sms" && sentSMSSuccess) || 
                                    (channel === "whatsapp" && sentWASuccess) || 
                                    (channel === "email" && sentEmailSuccess);
            if (expectedSuccess) {
              successCount++;
            } else {
              failCount++;
              errors.push(`${app.phone}: Gönderim başarısız.`);
            }
          }

          // If at least one channel succeeded, log it to reminder_logs
          const actualSent = sentEmailSuccess || sentWASuccess || sentSMSSuccess;
          if (actualSent) {
            try {
              let logChannel = "sms";
              if (sentWASuccess) logChannel = "whatsapp";
              else if (sentEmailSuccess) logChannel = "email";

              await fetch(`${supabaseUrl}/rest/v1/reminder_logs`, {
                method: "POST",
                headers: {
                  "apikey": supabaseAnonKey,
                  "Authorization": `Bearer ${supabaseAnonKey}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  application_id: app.id,
                  plate_number: app.plate_number || app.plate || "",
                  phone: app.phone,
                  days_left: daysLeft,
                  channel: logChannel
                })
              });
            } catch (dbLogErr) {
              console.error(`[Cron Reminder DB Log Error] for app ${app.id}:`, dbLogErr);
            }
          }
        } catch (singleAppErr) {
          failCount++;
          errors.push(`${app.phone}: ${singleAppErr.message}`);
        }
      }

      executionResults.push({
        daysLeft,
        processed: processedCount,
        success: successCount,
        failed: failCount,
        errors
      });
    }

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      results: executionResults
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
