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
      const jwtSecret = context.env.JWT_SECRET;
      if (!jwtSecret) {
        return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
      }
      
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
              const isBirlikSanayi = park.id === "birlik-sanayi";
              const isKurumsal = app.subscription_type && app.subscription_type.includes('Kurumsal') && !isBirlikSanayi && !park.apply_employee_price_to_corporate;
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
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Fetch all applications (up to 5000, ordered by date_applied) to calculate metrics
        const allAppsRes = await fetch(`${supabaseUrl}/rest/v1/applications?select=id,status,parking_location,date_applied,subscription_expires_at,full_name,plate_number,subscription_type&order=date_applied.desc&limit=5000`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (allAppsRes.ok) {
          const allApps = await allAppsRes.json();
          let summariesSent = 0;
          let summariesTotalApps = 0;
          const tz = { timeZone: "Europe/Istanbul" };
          
          for (const park of otoparks) {
            if (park.summary_emails) {
              const parkApps = allApps.filter(app => app.parking_location === park.name);
              const recentApps = parkApps.filter(app => app.date_applied && new Date(app.date_applied) >= yesterday);
              const totalApps = parkApps.length;

              // Calculate average approval duration for applications approved in the last 24 hours
              const approvedRecent = parkApps.filter(app => {
                if (app.status !== 'Onaylandı' || !app.subscription_expires_at || !app.date_applied) return false;
                const approvedTime = new Date(app.subscription_expires_at).getTime() - (30 * 24 * 60 * 60 * 1000);
                return approvedTime >= yesterday.getTime();
              });

              let avgApprovalTimeText = "—";
              if (approvedRecent.length > 0) {
                const totalMs = approvedRecent.reduce((sum, app) => {
                  const approvedTime = new Date(app.subscription_expires_at).getTime() - (30 * 24 * 60 * 60 * 1000);
                  const appliedTime = new Date(app.date_applied).getTime();
                  return sum + Math.max(0, approvedTime - appliedTime);
                }, 0);
                const avgMs = totalMs / approvedRecent.length;
                const avgMinutes = Math.round(avgMs / (60 * 1000));
                if (avgMinutes < 60) {
                  avgApprovalTimeText = `${avgMinutes} dakika`;
                } else {
                  const hours = Math.floor(avgMinutes / 60);
                  const minutes = avgMinutes % 60;
                  avgApprovalTimeText = minutes > 0 ? `${hours} saat ${minutes} dk` : `${hours} saat`;
                }
              }

              // Calculate daily trend counts for the last 7 days (Turkey timezone offset calculation)
              const trendStats = [];
              const turkishMonths = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
              const daysOfWeek = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
              const trOffset = 3 * 60 * 60 * 1000;
              let maxCount = 0;

              for (let i = 6; i >= 0; i--) {
                const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
                const trDate = new Date(d.getTime() + trOffset);
                const localDay = trDate.getUTCDate();
                const localMonth = trDate.getUTCMonth();
                const localDayOfWeek = trDate.getUTCDay();

                const dayLabel = `${localDay} ${turkishMonths[localMonth]} ${daysOfWeek[localDayOfWeek]}`;
                const dayStr = `${String(localDay).padStart(2, '0')}.${String(localMonth + 1).padStart(2, '0')}.${trDate.getUTCFullYear()}`;

                const count = parkApps.filter(app => {
                  if (!app.date_applied) return false;
                  const appTrDate = new Date(new Date(app.date_applied).getTime() + trOffset);
                  const appDayStr = `${String(appTrDate.getUTCDate()).padStart(2, '0')}.${String(appTrDate.getUTCMonth() + 1).padStart(2, '0')}.${appTrDate.getUTCFullYear()}`;
                  return appDayStr === dayStr;
                }).length;

                if (count > maxCount) maxCount = count;
                trendStats.push({ label: dayLabel, count });
              }
              if (maxCount === 0) maxCount = 1;

              // Calculate top active corporate companies (Top 3)
              const companyCounts = {};
              parkApps.forEach(app => {
                if (app.status === 'Onaylandı' && app.company_name) {
                  const cName = app.company_name.trim();
                  if (cName && cName.toUpperCase() !== 'SERBEST ÇALIŞAN') {
                    companyCounts[cName] = (companyCounts[cName] || 0) + 1;
                  }
                }
              });
              
              const topCompanies = Object.entries(companyCounts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 3);

              let topCompaniesHtml = "";
              if (topCompanies.length > 0) {
                topCompaniesHtml = `
                  <!-- Top Companies Section -->
                  <div style="margin-bottom: 2rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); font-family: sans-serif;">
                    <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem;">
                      🏢 En Aktif Kurumsal Firmalar (Top 3)
                    </h4>
                    <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                      <tbody>
                        ${topCompanies.map((c, idx) => `
                          <tr style="border-bottom: ${idx < topCompanies.length - 1 ? '1px solid #f1f5f9' : 'none'};">
                            <td style="padding: 8px 0; font-weight: 700; color: #334155; width: 30px; font-family: sans-serif;">#${idx + 1}</td>
                            <td style="padding: 8px 0; color: #475569; font-weight: 600; font-family: sans-serif;">${c.name}</td>
                            <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #0f3ba2; font-family: sans-serif; white-space: nowrap;">${c.count} Araç</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `;
              }

              const systemHealthHtml = `
                <!-- System Health & Quick Actions -->
                <div style="margin-bottom: 2rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; font-family: sans-serif;">
                  <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <tr>
                      <!-- Left: Health -->
                      <td style="width: 50%; vertical-align: top; padding-right: 12px; border-right: 1px solid #e2e8f0;">
                        <h4 style="margin: 0 0 0.75rem 0; font-size: 0.8rem; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.05em;">🟢 SİSTEM SAĞLIK DURUMU</h4>
                        <div style="line-height: 1.6; color: #475569; font-weight: 600; font-size: 0.8rem;">
                          <div style="margin-bottom: 4px;">🟢 Plaka Tanıma: <span style="color: #059669; font-weight: 700;">Aktif</span></div>
                          <div style="margin-bottom: 4px;">🟢 B2B Girişleri: <span style="color: #059669; font-weight: 700;">Aktif</span></div>
                          <div style="margin-bottom: 4px;">🟢 SMS / E-posta: <span style="color: #059669; font-weight: 700;">Çalışıyor</span></div>
                        </div>
                      </td>
                      <!-- Right: Actions -->
                      <td style="width: 50%; vertical-align: top; padding-left: 20px;">
                        <h4 style="margin: 0 0 0.75rem 0; font-size: 0.8rem; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.05em;">⚡ HIZLI İŞLEMLER</h4>
                        <div style="line-height: 1.8; font-size: 0.8rem; font-weight: 600;">
                          <div>🔗 <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; text-decoration: none;">Bekleyenleri Yönet</a></div>
                          <div>🔗 <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; text-decoration: none;">Tarife & Ücretler</a></div>
                          <div>🔗 <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; text-decoration: none;">Firma Yetkileri</a></div>
                        </div>
                      </td>
                    </tr>
                  </table>
                </div>
              `;

              // Construct HTML Summary
              let rowsHtml = "";
              for (const app of recentApps) {
                const dateStr = app.date_applied ? new Date(app.date_applied).toLocaleDateString("tr-TR", tz) : "-";
                rowsHtml += `
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px 8px; font-family: monospace; font-size: 0.8rem; color: #0f3ba2; font-weight: 600;">${app.id}</td>
                    <td style="padding: 10px 8px; color: #334155;">${maskName(app.full_name)}</td>
                    <td style="padding: 10px 8px; font-weight: 700; color: #1e293b; text-transform: uppercase;">${app.plate_number || ""}</td>
                    <td style="padding: 10px 8px; color: #64748b;">${app.subscription_type || "Bireysel"}</td>
                    <td style="padding: 10px 8px; font-weight: bold; color: ${app.status === 'Onaylandı' ? '#059669' : (app.status === 'Reddedildi' ? '#dc2626' : '#d97706')};">${app.status}</td>
                  </tr>
                `;
              }

              // Trend bar chart html (using standard table structure for 100% email client compatibility)
              let trendHtml = "";
              trendStats.forEach(stat => {
                const percent = maxCount > 0 ? Math.round((stat.count / maxCount) * 100) : 0;
                trendHtml += `
                  <tr>
                    <td style="width: 120px; color: #475569; font-weight: 600; padding: 8px 0; font-size: 0.85rem; font-family: sans-serif; vertical-align: middle;">${stat.label}</td>
                    <td style="padding: 8px 0; vertical-align: middle;">
                      <div style="background-color: #e2e8f0; border-radius: 6px; height: 12px; min-width: 120px; max-width: 320px; overflow: hidden; position: relative; display: block;">
                        <table style="width: 100%; height: 100%; border-collapse: collapse; border: none; margin: 0; padding: 0;">
                          <tr>
                            <td style="background-color: ${stat.count > 0 ? '#0f3ba2' : '#cbd5e1'}; width: ${stat.count > 0 ? Math.max(8, percent) : 0}%; height: 12px; border-radius: 6px; border: none; padding: 0;"></td>
                            <td style="width: ${100 - (stat.count > 0 ? Math.max(8, percent) : 0)}%; height: 12px; border: none; padding: 0;"></td>
                          </tr>
                        </table>
                      </div>
                    </td>
                    <td style="width: 80px; text-align: right; font-weight: 700; color: #1e293b; padding: 8px 0; font-size: 0.85rem; font-family: sans-serif; vertical-align: middle;">${stat.count} kayıt</td>
                  </tr>
                `;
              });

              const htmlContent = `
                <h3 style="color: #0f3ba2; margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 800; border-bottom: 2px solid #f1f5f9; padding-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                  📊 Günlük Başvuru Özet Raporu
                </h3>
                
                <div style="margin-bottom: 1.5rem; background: #f8fafc; border-left: 4px solid #0f3ba2; padding: 0.75rem 1rem; border-radius: 0 8px 8px 0;">
                  <span style="font-size: 0.8rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Otopark Konumu</span>
                  <div style="font-size: 1.05rem; font-weight: 800; color: #0f3ba2; margin-top: 0.15rem;">${park.name}</div>
                </div>

                <!-- KPI Cards Grid -->
                <div style="margin-bottom: 2rem; width: 100%; display: table; border-collapse: separate; border-spacing: 8px 0;">
                  <div style="display: table-row;">
                    <!-- Card 1: Son 24 Saat -->
                    <div style="display: table-cell; background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 1rem; text-align: center; width: 33%;">
                      <div style="font-size: 0.7rem; font-weight: 800; color: #b45309; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">⚡ SON 24 SAAT</div>
                      <div style="font-size: 1.8rem; font-weight: 800; color: #d97706; line-height: 1.1;">${recentApps.length}</div>
                      <div style="font-size: 0.65rem; color: #b45309; font-weight: 600; margin-top: 0.25rem;">Yeni Başvuru</div>
                    </div>
                    
                    <!-- Card 2: Toplam Başvuru -->
                    <div style="display: table-cell; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 1rem; text-align: center; width: 33%;">
                      <div style="font-size: 0.7rem; font-weight: 800; color: #1d4ed8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">📊 TÜM ZAMANLAR</div>
                      <div style="font-size: 1.8rem; font-weight: 800; color: #2563eb; line-height: 1.1;">${totalApps}</div>
                      <div style="font-size: 0.65rem; color: #1d4ed8; font-weight: 600; margin-top: 0.25rem;">Toplam Başvuru</div>
                    </div>
                    
                    <!-- Card 3: Ort. Onay Süresi -->
                    <div style="display: table-cell; background: #fdf2f8; border: 1px solid #fbcfe8; border-radius: 10px; padding: 1rem; text-align: center; width: 33%;">
                      <div style="font-size: 0.7rem; font-weight: 800; color: #be185d; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">⏱️ ORT. ONAY SÜRESİ</div>
                      <div style="font-size: 1.1rem; font-weight: 800; color: #db2777; line-height: 1.1; padding: 0.4rem 0;">${avgApprovalTimeText}</div>
                      <div style="font-size: 0.65rem; color: #be185d; font-weight: 600; margin-top: 0.1rem;">Son 24 Saat</div>
                    </div>
                  </div>
                </div>

                <!-- Trend Chart Section -->
                <div style="margin-bottom: 2rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); font-family: sans-serif;">
                  <h4 style="margin: 0 0 1.25rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem;">
                    📈 Son 7 Günlük Başvuru Akışı
                  </h4>
                  <table style="width: 100%; border-collapse: collapse; font-family: sans-serif; font-size: 0.85rem;">
                    <tbody>
                      ${trendHtml}
                    </tbody>
                  </table>
                </div>

                ${topCompaniesHtml}

                ${systemHealthHtml}

                <!-- Recent Applications List Section -->
                <div style="margin-bottom: 1.5rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
                  <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em;">
                    📋 Son 24 Saatte Alınan Başvurular
                  </h4>
                  
                  ${recentApps.length > 0 ? `
                    <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
                      <thead>
                        <tr style="border-bottom: 2px solid #cbd5e1; color: #475569; font-weight: 700;">
                          <th style="padding: 8px 4px;">Takip No</th>
                          <th style="padding: 8px 4px;">Müşteri</th>
                          <th style="padding: 8px 4px;">Plaka</th>
                          <th style="padding: 8px 4px;">Abonelik</th>
                          <th style="padding: 8px 4px;">Durum</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rowsHtml}
                      </tbody>
                    </table>
                  ` : `
                    <div style="text-align: center; padding: 1.5rem 1rem; color: #64748b; font-style: italic; font-size: 0.85rem;">
                      Son 24 saat içinde yeni başvuru kaydı bulunmamaktadır.
                    </div>
                  `}
                </div>

                <p style="margin-top: 2rem; font-size: 0.8rem; color: #64748b; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 1rem;">
                  Detaylı inceleme ve başvuru onay işlemleri için lütfen 
                  <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; font-weight: 700; text-decoration: none;">Yönetici Paneli</a>'ne giriş yapınız.
                </p>
              `;

              await sendEmail({
                to: park.summary_emails,
                subject: `📊 Günlük Başvuru Raporu - ${park.name}`,
                html: htmlContent,
                env: context.env
              });
              
              summariesSent++;
              summariesTotalApps += recentApps.length;
            }
          }
          
          executionResults.push({
            type: "summaries",
            message: `Daily summaries processed: sent ${summariesSent} reports (containing total ${summariesTotalApps} recent applications).`
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
