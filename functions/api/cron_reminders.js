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

// Helper to mask first and last name for privacy compliance
function maskName(name) {
  if (!name) return "";
  return name.trim().split(/\s+/).map(word => {
    if (!word) return "";
    if (word.length <= 2) return word;
    return word.substring(0, 2) + "*".repeat(word.length - 2);
  }).filter(Boolean).join(" ");
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const runType = url.searchParams.get("run") || "all";

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

  // 1. Verify Authorization (either Bearer cronSecret OR Bearer adminToken)
  const authHeader = context.request.headers.get("Authorization");
  let isAuthorized = false;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token === cronSecret) {
      isAuthorized = true;
    } else {
      // Validate as admin JWT token
      const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";
      
      const verifyTokenInline = async (tok, sec, clientIp, supabaseUrl, supabaseAnonKey) => {
        try {
          const parts = tok.split(".");
          if (parts.length !== 2) return null;
          
          const binString = atob(parts[0]);
          const bytes = new Uint8Array(binString.length);
          for (let i = 0; i < binString.length; i++) {
            bytes[i] = binString.charCodeAt(i);
          }
          const payloadStr = new TextDecoder().decode(bytes);
          const signatureHex = parts[1];
          
          const encoder = new TextEncoder();
          const keyData = encoder.encode(sec);
          const key = await crypto.subtle.importKey(
            "raw",
            keyData,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
          );
          
          const signatureBuffer = await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(payloadStr)
          );
          const signatureArray = Array.from(new Uint8Array(signatureBuffer));
          const reSignatureHex = signatureArray.map(b => b.toString(16).padStart(2, "0")).join("");
          
          if (signatureHex === reSignatureHex) {
            const payload = JSON.parse(payloadStr);
            if (payload.exp && payload.exp < Date.now()) {
              return null; // Expired
            }
            // Enforce IP binding for superadmin
            if (payload.role === "superadmin") {
              if (!payload.ip || payload.ip !== clientIp) {
                return null; // IP mismatch or missing IP claim!
              }
            }
            // Check blacklist
            if (payload.jti && supabaseUrl && supabaseAnonKey) {
              try {
                const blRes = await fetch(`${supabaseUrl}/rest/v1/blacklisted_tokens?jti=eq.${payload.jti}&select=jti`, {
                  headers: {
                    "apikey": supabaseAnonKey,
                    "Authorization": `Bearer ${supabaseAnonKey}`
                  }
                });
                if (blRes.ok) {
                  const rows = await blRes.json();
                  if (rows.length > 0) {
                    return null; // Blacklisted!
                  }
                }
              } catch (e) {
                console.error("Blacklist check error:", e);
              }
            } else {
              return null; // Force log out for old tokens without JTI
            }
            return payload;
          }
        } catch (e) {
          return null;
        }
        return null;
      };

      const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
      const user = await verifyTokenInline(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
      if (user && user.role === "superadmin") {
        isAuthorized = true;
      }
    }
  }

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: "Unauthorized access. Invalid or missing credentials." }), { status: 401, headers });
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
    const settings = rows.length > 0 ? (rows[0].value || {}) : {};
    const autoRemindersEnabled = settings.auto_reminders_enabled === true;

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
    const shouldRunReminders = runType === "all" || runType === "reminders";
    if (shouldRunReminders) {
      if (autoRemindersEnabled) {
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

            // Anti-ban human-like random delay (2 to 5 seconds) after processing each application
            if (expiringApps.indexOf(app) < expiringApps.length - 1) {
              const delayMs = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
              await sleep(delayMs);
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
      } else {
        executionResults.push({ message: "Customer reminders are disabled (auto_reminders_enabled = false)" });
      }
    } else {
      executionResults.push({ message: "Customer reminders execution skipped." });
    }

    // 5. Send Daily Summaries to Otopark Admins (if daily_summary is enabled)
    const shouldRunSummaries = runType === "all" || runType === "summaries";
    if (shouldRunSummaries) {
      try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayIso = yesterday.toISOString();

        // Fetch all applications in the last 24 hours
        const recentAppsRes = await fetch(`${supabaseUrl}/rest/v1/applications?date_applied=gte.${yesterdayIso}&select=*`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (recentAppsRes.ok) {
          const recentApps = await recentAppsRes.json();
          let summariesSent = 0;
          let summariesTotalApps = 0;
          
          for (const park of otoparks) {
            if (park.summary_emails) {
              const parkApps = recentApps.filter(app => app.parking_location === park.name);
              if (parkApps.length > 0) {
                // Construct HTML Summary
                let rowsHtml = "";
                for (const app of parkApps) {
                  const dateStr = app.date_applied ? new Date(app.date_applied).toLocaleDateString("tr-TR") : "-";
                  rowsHtml += `
                    <tr>
                      <td style="padding: 8px; border: 1px solid #ddd; font-family: monospace;">${app.id}</td>
                      <td style="padding: 8px; border: 1px solid #ddd;">${maskName(app.full_name)}</td>
                      <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; text-transform: uppercase;">${app.plate_number || ""}</td>
                      <td style="padding: 8px; border: 1px solid #ddd;">${app.subscription_type || ""}</td>
                      <td style="padding: 8px; border: 1px solid #ddd;">${dateStr}</td>
                      <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; color: ${app.status === 'Onaylandı' ? '#047857' : (app.status === 'Reddedildi' ? '#b91c1c' : '#b45309')}">${app.status}</td>
                    </tr>
                  `;
                }

                const htmlContent = `
                  <h3 style="color: #0f3ba2; margin-top: 0;">📊 Günlük Başvuru Özet Raporu</h3>
                  <p><strong>Otopark Konumu:</strong> ${park.name}</p>
                  <p>Son 24 saat içerisinde alınan toplam başvuru sayısı: <strong>${parkApps.length}</strong></p>
                  
                  <table style="width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.85rem;">
                    <thead>
                      <tr style="background: #f1f5f9; text-align: left; font-weight: bold;">
                        <th style="padding: 8px; border: 1px solid #ddd;">Takip No</th>
                        <th style="padding: 8px; border: 1px solid #ddd;">Müşteri</th>
                        <th style="padding: 8px; border: 1px solid #ddd;">Plaka</th>
                        <th style="padding: 8px; border: 1px solid #ddd;">Abonelik Tipi</th>
                        <th style="padding: 8px; border: 1px solid #ddd;">Tarih</th>
                        <th style="padding: 8px; border: 1px solid #ddd;">Durum</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rowsHtml}
                    </tbody>
                  </table>
                  <p style="margin-top: 1.5rem; font-size: 0.8rem; color: #64748b;">Detaylı inceleme ve onay işlemleri için lütfen <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; font-weight: 600; text-decoration: none;">Yönetici Paneli</a>'ne giriş yapınız.</p>
                `;

                await sendEmail({
                  to: park.summary_emails,
                  subject: `📊 Günlük Başvuru Raporu - ${park.name}`,
                  html: htmlContent,
                  env: context.env
                });
                
                summariesSent++;
                summariesTotalApps += parkApps.length;
              }
            }
          }
          
          executionResults.push({
            type: "summaries",
            message: `Daily summaries processed: sent ${summariesSent} reports (containing total ${summariesTotalApps} applications).`
          });
        }
      } catch (summaryErr) {
        console.error("[Cron Summary Error]:", summaryErr);
        executionResults.push({ type: "summaries", error: summaryErr.message });
      }
    } else {
      executionResults.push({ message: "Daily summaries execution skipped." });
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
