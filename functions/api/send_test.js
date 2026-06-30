import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";
import { sendSMS } from "./sms_helper.js";

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  // Generate a random mock application ID
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let randomCode = "";
  for (let i = 0; i < 4; i++) {
    randomCode += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const mockAppId = `PE-TEST-${randomCode}`;
  
  let testEmail = "talha.emre.calargun@parkexpert.net";
  let testPhone = "5372939874"; // +90 537 293 98 74
  let scheduledDate = null;
  let flashSms = false;
  let requestType = "standard";
  let selectedParkingLocation = "Birlik Sanayi Sitesi - Beylikdüzü";
  let mode = "mock";

  try {
    const body = await context.request.json();
    if (body.email) testEmail = body.email.trim();
    if (body.phone) testPhone = body.phone.trim();
    if (body.scheduledDate) scheduledDate = body.scheduledDate;
    if (body.flashSms !== undefined) flashSms = body.flashSms === true;
    if (body.type) requestType = body.type.trim();
    if (body.parkingLocation) selectedParkingLocation = body.parkingLocation.trim();
    if (body.mode) mode = body.mode.trim();
  } catch (e) {
    // ignore, use defaults
  }

  function maskName(name) {
    if (!name) return "";
    const parts = name.trim().split(/\s+/);
    return parts.map(part => {
      if (part.length <= 2) return part[0] + "*".repeat(part.length - 1);
      return part.slice(0, 2) + "*".repeat(part.length - 2);
    }).join(" ");
  }

  // Handle Daily Summary test request
  if (requestType === "summary") {
    try {
      const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(selectedParkingLocation)}&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      let parkName = selectedParkingLocation;
      if (otoparkRes.ok) {
        const parks = await otoparkRes.json();
        if (parks.length > 0) {
          parkName = parks[0].name;
        }
      }

      let recentApps = [];
      let parkApps = [];
      let totalApps = 0;
      let avgApprovalTimeText = "—";
      let trendStats = [];
      let maxCount = 1;
      let bannerHtml = "";
      let emailSubject = "";

      const tz = { timeZone: "Europe/Istanbul" };
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Helper to calculate average approval time for a set of applications
      const getAvgApprovalTime = (apps) => {
        if (!apps || !Array.isArray(apps)) return "";
        const approved = apps.filter(app => {
          return app.status === 'Onaylandı' && app.subscription_expires_at && app.date_applied;
        });
        if (approved.length === 0) return "";
        const totalMs = approved.reduce((sum, app) => {
          const approvedTime = new Date(app.subscription_expires_at).getTime() - (30 * 24 * 60 * 60 * 1000);
          const appliedTime = new Date(app.date_applied).getTime();
          return sum + Math.max(0, approvedTime - appliedTime);
        }, 0);
        const avgMs = totalMs / approved.length;
        const avgMinutes = Math.round(avgMs / (60 * 1000));
        if (avgMinutes < 60) {
          return `${avgMinutes} dk`;
        } else {
          const hours = Math.floor(avgMinutes / 60);
          const minutes = avgMinutes % 60;
          return minutes > 0 ? `${hours} sa ${minutes} dk` : `${hours} sa`;
        }
      };

      if (mode === "real") {
        const allAppsRes = await fetch(`${supabaseUrl}/rest/v1/applications?select=id,status,parking_location,date_applied,subscription_expires_at,full_name,plate_number,subscription_type&order=date_applied.desc&limit=5000`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (!allAppsRes.ok) {
          throw new Error("Veritabanından başvurular çekilemedi.");
        }

        const allApps = await allAppsRes.json();
        parkApps = allApps.filter(app => app.parking_location === selectedParkingLocation);
        recentApps = parkApps.filter(app => app.date_applied && new Date(app.date_applied) >= yesterday);
        totalApps = parkApps.length;

        // Calculate average approval duration for applications approved in the last 24 hours
        const approvedRecent = parkApps.filter(app => {
          if (app.status !== 'Onaylandı' || !app.subscription_expires_at || !app.date_applied) return false;
          const approvedTime = new Date(app.subscription_expires_at).getTime() - (30 * 24 * 60 * 60 * 1000);
          return approvedTime >= yesterday.getTime();
        });

        avgApprovalTimeText = getAvgApprovalTime(approvedRecent) ? `${getAvgApprovalTime(approvedRecent)}` : "—";

        // Calculate daily trend counts for the last 7 days (Turkey timezone offset calculation)
        const daysOfWeek = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
        const turkishMonths = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
        const trOffset = 3 * 60 * 60 * 1000;
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          const trDate = new Date(d.getTime() + trOffset);
          const localDay = trDate.getUTCDate();
          const localMonth = trDate.getUTCMonth();
          const localDayOfWeek = trDate.getUTCDay();

          const dayLabel = `${localDay} ${turkishMonths[localMonth]} ${daysOfWeek[localDayOfWeek]}`;
          const dayStr = `${String(localDay).padStart(2, '0')}.${String(localMonth + 1).padStart(2, '0')}.${trDate.getUTCFullYear()}`;
          
          const dayApps = parkApps.filter(app => {
            if (!app.date_applied) return false;
            const appTrDate = new Date(new Date(app.date_applied).getTime() + trOffset);
            const appDayStr = `${String(appTrDate.getUTCDate()).padStart(2, '0')}.${String(appTrDate.getUTCMonth() + 1).padStart(2, '0')}.${appTrDate.getUTCFullYear()}`;
            return appDayStr === dayStr;
          });
          
          const count = dayApps.length;
          if (count > maxCount) maxCount = count;
          const avgTimeText = getAvgApprovalTime(dayApps);
          trendStats.push({ label: dayLabel, count, avgTimeText });
        }

        bannerHtml = `
          <div style="border: 2px solid #0f3ba2; padding: 12px; margin-bottom: 20px; background-color: #f8fafc; border-radius: 8px; text-align: center; font-family: sans-serif;">
            <strong style="color: #0f3ba2; font-size: 0.95rem;">📢 MANUEL TETİKLENMİŞ GERÇEK RAPOR</strong><br>
            <span style="font-size: 0.8rem; color: #64748b;">Bu e-posta yönetici paneli üzerinden güncel canlı verilerle manuel olarak tetiklenmiştir.</span>
          </div>
        `;
        emailSubject = `📊 Günlük Başvuru Raporu (Manuel Tetikleme) - ${parkName}`;
      } else {
        // Mock Mode
        totalApps = 48;
        avgApprovalTimeText = "45 dk";
        recentApps = [
          { id: "PE-TEST-X9Y2", full_name: "Ahmet Yılmaz", plate_number: "34ABC123", subscription_type: "Bireysel (1 Aylık)", date_applied: new Date().toISOString(), status: "Onaylandı" },
          { id: "PE-TEST-M4N8", full_name: "Mehmet Kaya", plate_number: "34XYZ789", subscription_type: "Kurumsal (3 Aylık)", date_applied: new Date().toISOString(), status: "Beklemede" },
          { id: "PE-TEST-K7L3", full_name: "Ayşe Demir", plate_number: "34KLM456", subscription_type: "Bireysel (6 Aylık)", date_applied: new Date().toISOString(), status: "Reddedildi" }
        ];

        const daysOfWeek = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
        const turkishMonths = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
        const trOffset = 3 * 60 * 60 * 1000;
        const mockCounts = [2, 5, 3, 8, 4, 6, 3];
        const mockAverages = ["45 dk", "30 dk", "", "1 sa 10 dk", "25 dk", "15 dk", ""];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          const trDate = new Date(d.getTime() + trOffset);
          const localDay = trDate.getUTCDate();
          const localMonth = trDate.getUTCMonth();
          const localDayOfWeek = trDate.getUTCDay();

          const dayLabel = `${localDay} ${turkishMonths[localMonth]} ${daysOfWeek[localDayOfWeek]}`;
          const count = mockCounts[6 - i];
          if (count > maxCount) maxCount = count;
          trendStats.push({ label: dayLabel, count, avgTimeText: mockAverages[6 - i] });
        }

        bannerHtml = `
          <div style="border: 2px dashed #0f3ba2; padding: 12px; margin-bottom: 20px; background-color: #f8fafc; border-radius: 8px; text-align: center; font-family: sans-serif;">
            <strong style="color: #0f3ba2; font-size: 0.95rem;">⚠️ BU BİR TEST GÖNDERİMİDİR (MOCK)</strong><br>
            <span style="font-size: 0.8rem; color: #64748b;">Bu e-posta otopark ayarlarından "Test Raporu (Mock)" butonuna basılarak tetiklenmiştir.</span>
          </div>
        `;
        emailSubject = `📊 Günlük Başvuru Raporu (TEST) - ${parkName}`;
      }

      // Calculate top active corporate companies (Top 3)
      let topCompanies = [];
      if (mode === "real") {
        const companyCounts = {};
        parkApps.forEach(app => {
          if (app.status === 'Onaylandı' && app.company_name) {
            const cName = app.company_name.trim();
            if (cName && cName.toUpperCase() !== 'SERBEST ÇALIŞAN') {
              companyCounts[cName] = (companyCounts[cName] || 0) + 1;
            }
          }
        });
        
        topCompanies = Object.entries(companyCounts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 3);
      } else {
        // Mock Top Companies
        topCompanies = [
          { name: "NEUMO MÜHENDİSLİK VE PASLANMAZ ÇELİK SAN. TİC. LTD. ŞTİ.", count: 12 },
          { name: "DM METAL SAC İŞLEME MERKEZİ SAN. TİC. LTD. ŞTİ.", count: 8 },
          { name: "PROAKS METAL YAPI SİSTEMLERİ SAN TİC LTD ŞTİ", count: 4 }
        ];
      }

      let topCompaniesHtml = "";
      if (topCompanies.length > 0) {
        topCompaniesHtml = `
          <!-- Top Companies Section -->
          <div style="margin-bottom: 2rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); font-family: sans-serif;">
            <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem;">
              🏢 En Aktif Kurumsal Firmalar (Top 3) ${mode === 'mock' ? '(Mock)' : ''}
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

      // Calculate all-time daily registration stats grouped by day
      let allTimeStats = [];
      if (mode === "real") {
        const allTimeStatsMap = {};
        const daysOfWeek = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
        const turkishMonths = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
        const trOffset = 3 * 60 * 60 * 1000;
        
        parkApps.forEach(app => {
          if (!app.date_applied) return;
          const appTrDate = new Date(new Date(app.date_applied).getTime() + trOffset);
          const localDay = appTrDate.getUTCDate();
          const localMonth = appTrDate.getUTCMonth();
          const year = appTrDate.getUTCFullYear();
          const dayStr = `${String(localDay).padStart(2, '0')}.${String(localMonth + 1).padStart(2, '0')}.${year}`;
          const dayLabel = `${localDay} ${turkishMonths[localMonth]} ${year} ${daysOfWeek[appTrDate.getUTCDay()]}`;
          
          if (!allTimeStatsMap[dayStr]) {
            const midnightDate = new Date(year, localMonth, localDay).getTime();
            allTimeStatsMap[dayStr] = { label: dayLabel, count: 0, rawDate: midnightDate, apps: [] };
          }
          allTimeStatsMap[dayStr].count++;
          allTimeStatsMap[dayStr].apps.push(app);
        });

        allTimeStats = Object.values(allTimeStatsMap).sort((a, b) => b.rawDate - a.rawDate);
      } else {
        // Mock All Time stats (sorted newest first)
        allTimeStats = [
          { label: "22 Haz 2026 Çar", count: 5 },
          { label: "20 Haz 2026 Pzt", count: 9 },
          { label: "18 Haz 2026 Cmt", count: 2 },
          { label: "15 Haz 2026 Sal", count: 7 },
          { label: "12 Haz 2026 Cmt", count: 4 }
        ];
      }

      let allTimeStatsHtml = "";
      if (allTimeStats.length > 0) {
        allTimeStatsHtml = `
          <!-- All Time Daily Distribution Section -->
          <div style="margin-bottom: 2rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); font-family: sans-serif;">
            <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem;">
              📅 Tüm Zamanlar Günlük Başvuru Dağılımı ${mode === 'mock' ? '(Mock)' : ''}
            </h4>
            <div style="max-height: 250px; overflow-y: auto; -webkit-overflow-scrolling: touch;">
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                <tbody>
                  ${allTimeStats.map((stat, idx) => {
                    const avgTimeText = (mode === 'real') ? getAvgApprovalTime(stat.apps) : (idx === 0 ? "12 dk" : idx === 1 ? "45 dk" : idx === 2 ? "8 dk" : idx === 3 ? "1 sa 15 dk" : "32 dk");
                    return `
                      <tr style="border-bottom: ${idx < allTimeStats.length - 1 ? '1px solid #f1f5f9' : 'none'};">
                        <td style="padding: 8px 0; color: #475569; font-weight: 600; font-family: sans-serif; white-space: nowrap;">${stat.label}</td>
                        <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #0f3ba2; font-family: sans-serif; white-space: nowrap;">
                          ${stat.count} kayıt ${avgTimeText ? `<span style="font-size: 0.75rem; color: #64748b; font-weight: 500; margin-left: 4px;">(Ort: ${avgTimeText})</span>` : ""}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }

      const systemHealthHtml = `
        <!-- System Health & Quick Actions -->
        <div style="margin-bottom: 2rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; font-family: sans-serif;">
          <table class="two-col-table" style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
            <tr>
              <!-- Left: Health -->
              <td style="width: 50%; vertical-align: top; padding-right: 12px; border-right: 1px solid #e2e8f0;">
                <h4 style="margin: 0 0 0.75rem 0; font-size: 0.8rem; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; font-family: sans-serif;">
                  <span class="pulse-dot" style="display: inline-block; width: 8px; height: 8px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 6px #10b981; vertical-align: middle; margin-right: 6px;"></span>
                  <span style="vertical-align: middle;">SİSTEM SAĞLIK DURUMU</span>
                </h4>
                <div style="line-height: 1.6; color: #475569; font-weight: 600; font-size: 0.8rem; font-family: sans-serif;">
                  <div style="margin-bottom: 6px;">
                    <span class="pulse-dot" style="display: inline-block; width: 6px; height: 6px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 4px #10b981; vertical-align: middle; margin-right: 6px;"></span>
                    <span style="vertical-align: middle;">Plaka Tanıma: <span style="color: #059669; font-weight: 700;">Aktif</span></span>
                  </div>
                  <div style="margin-bottom: 6px;">
                    <span class="pulse-dot" style="display: inline-block; width: 6px; height: 6px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 4px #10b981; vertical-align: middle; margin-right: 6px;"></span>
                    <span style="vertical-align: middle;">B2B Girişleri: <span style="color: #059669; font-weight: 700;">Aktif</span></span>
                  </div>
                  <div style="margin-bottom: 6px;">
                    <span class="pulse-dot" style="display: inline-block; width: 6px; height: 6px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 4px #10b981; vertical-align: middle; margin-right: 6px;"></span>
                    <span style="vertical-align: middle;">SMS / E-posta: <span style="color: #059669; font-weight: 700;">Çalışıyor</span></span>
                  </div>
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
            <td class="trend-date" style="width: 120px; color: #475569; font-weight: 600; padding: 8px 0; font-size: 0.85rem; font-family: sans-serif; vertical-align: middle; white-space: nowrap;">${stat.label}</td>
            <td style="padding: 8px 0; vertical-align: middle;">
              <div class="trend-bar-container" style="background-color: #e2e8f0; border-radius: 6px; height: 12px; min-width: 120px; max-width: 320px; overflow: hidden; position: relative; display: block;">
                <table style="width: 100%; height: 100%; border-collapse: collapse; border: none; margin: 0; padding: 0;">
                  <tr>
                    <td style="background-color: ${stat.count > 0 ? '#0f3ba2' : '#cbd5e1'}; width: ${stat.count > 0 ? Math.max(8, percent) : 0}%; height: 12px; border-radius: 6px; border: none; padding: 0;"></td>
                    <td style="width: ${100 - (stat.count > 0 ? Math.max(8, percent) : 0)}%; height: 12px; border: none; padding: 0;"></td>
                  </tr>
                </table>
              </div>
            </td>
            <td class="trend-count" style="width: 140px; text-align: right; font-weight: 700; color: #1e293b; padding: 8px 0; font-size: 0.85rem; font-family: sans-serif; vertical-align: middle; line-height: 1.25; white-space: nowrap;">
              ${stat.count} kayıt ${stat.avgTimeText ? `<br><span style="font-size: 0.75rem; color: #64748b; font-weight: 500;">(Ort: ${stat.avgTimeText})</span>` : ""}
            </td>
          </tr>
        `;
      });

      const htmlContent = `
        ${bannerHtml}
        
        <h3 style="color: #0f3ba2; margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 800; border-bottom: 2px solid #f1f5f9; padding-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; font-family: sans-serif;">
          📊 Günlük Başvuru Özet Raporu ${mode === 'mock' ? '(TEST)' : ''}
        </h3>
        
        <div style="margin-bottom: 1.5rem; background: #f8fafc; border-left: 4px solid #0f3ba2; padding: 0.75rem 1rem; border-radius: 0 8px 8px 0; font-family: sans-serif;">
          <span style="font-size: 0.8rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Otopark Konumu</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: #0f3ba2; margin-top: 0.15rem;">${parkName}</div>
        </div>

        <!-- KPI Cards Grid -->
        <table class="kpi-table" style="margin-bottom: 2rem; width: 100%; border-collapse: separate; border-spacing: 8px 0; font-family: sans-serif;">
          <tr class="kpi-row">
            <!-- Card 1: Son 24 Saat -->
            <td class="kpi-card" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 1rem; text-align: center; width: 33%; vertical-align: top;">
              <div style="font-size: 0.7rem; font-weight: 800; color: #b45309; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">⚡ SON 24 SAAT</div>
              <div style="font-size: 1.8rem; font-weight: 800; color: #d97706; line-height: 1.1;">${recentApps.length}</div>
              <div style="font-size: 0.65rem; color: #b45309; font-weight: 600; margin-top: 0.25rem;">Yeni Başvuru ${mode === 'mock' ? '(Mock)' : ''}</div>
            </td>
            
            <!-- Card 2: Toplam Başvuru -->
            <td class="kpi-card" style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 1rem; text-align: center; width: 33%; vertical-align: top;">
              <div style="font-size: 0.7rem; font-weight: 800; color: #1d4ed8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">📊 TÜM ZAMANLAR</div>
              <div style="font-size: 1.8rem; font-weight: 800; color: #2563eb; line-height: 1.1;">${totalApps}</div>
              <div style="font-size: 0.65rem; color: #1d4ed8; font-weight: 600; margin-top: 0.25rem;">Toplam Başvuru ${mode === 'mock' ? '(Mock)' : ''}</div>
            </td>
            
            <!-- Card 3: Ort. Onay Süresi -->
            <td class="kpi-card" style="background: #fdf2f8; border: 1px solid #fbcfe8; border-radius: 10px; padding: 1rem; text-align: center; width: 33%; vertical-align: top;">
              <div style="font-size: 0.7rem; font-weight: 800; color: #be185d; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">⏱️ ORT. ONAY SÜRESİ</div>
              <div style="font-size: 1.1rem; font-weight: 800; color: #db2777; line-height: 1.1; padding: 0.4rem 0;">${avgApprovalTimeText}</div>
              <div style="font-size: 0.65rem; color: #be185d; font-weight: 600; margin-top: 0.1rem;">Son 24 Saat</div>
            </td>
          </tr>
        </table>

        <!-- Trend Chart Section -->
        <div style="margin-bottom: 2rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); font-family: sans-serif;">
          <h4 style="margin: 0 0 1.25rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem;">
            📈 Son 7 Günlük Başvuru Akışı ${mode === 'mock' ? '(Mock)' : ''}
          </h4>
          <table style="width: 100%; border-collapse: collapse; font-family: sans-serif; font-size: 0.85rem;">
            <tbody>
              ${trendHtml}
            </tbody>
          </table>
        </div>

        ${topCompaniesHtml}

        ${allTimeStatsHtml}

        ${systemHealthHtml}

        <!-- Recent Applications List Section -->
        <div style="margin-bottom: 1.5rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); font-family: sans-serif;">
          <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em;">
            📋 Son 24 Saatte Alınan Başvurular ${mode === 'mock' ? '(Mock)' : ''}
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

        <p style="margin-top: 2rem; font-size: 0.8rem; color: #64748b; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 1rem; font-family: sans-serif;">
          Detaylı inceleme ve başvuru onay işlemleri için lütfen 
          <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; font-weight: 700; text-decoration: none;">Yönetici Paneli</a>'ne giriş yapınız.
        </p>
      `;

      let emailSuccess = false;
      let emailError = null;
      try {
        const emailResult = await sendEmail({
          to: testEmail,
          subject: emailSubject,
          html: htmlContent,
          env: context.env
        });
        emailSuccess = emailResult.success !== false;
        if (!emailSuccess) emailError = emailResult.error;
      } catch (e) {
        emailError = e.message;
      }

      return new Response(JSON.stringify({
        success: true,
        mockAppId: mode === "real" ? "SUMMARY-REAL" : "SUMMARY-TEST",
        email: { success: emailSuccess, error: emailError },
        whatsapp: { success: false, error: "N/A" },
        sms: { success: false, error: "N/A" }
      }), { status: 200, headers });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  const parkingLocation = selectedParkingLocation;
  const fullName = "TEST KULLANICI (AHMET YILMAZ)";
  const plateNumber = "34TEST34";
  const subscriptionType = "Bireysel Abonelik (1 Aylık)";

  try {
    // 1. Fetch otopark details from Supabase
    const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(parkingLocation)}&select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });

    let park = {};
    if (otoparkRes.ok) {
      const parks = await otoparkRes.json();
      if (parks.length > 0) {
        park = parks[0];
      }
    }

    const bankName = park.bank_name || "ALBARAKA";
    const iban = park.iban || "TR00 0000 0000 0000 0000 0000 00";
    const companyTitle = park.company_title || "PARKEXPERT TEKNOLOJİ A.Ş.";
    const price = park.price_employee || "300";
    const supportPhone = park.support_phone || "02165044722";

    const templateVars = {
      fullName,
      appId: mockAppId,
      plateNumber,
      parkingLocation,
      subscriptionType,
      price,
      supportPhone,
      bankName,
      iban,
      companyTitle,
      carModel: 'Belirtilmedi'
    };

    const replaceVars = (str, vars) => {
      if (!str) return "";
      let res = str;
      for (const [k, v] of Object.entries(vars)) {
        const regex = new RegExp(`\\{${k}\\}`, "g");
        res = res.replace(regex, v);
      }
      return res;
    };

    const customTemplates = park.templates || {};
    const applyTemplates = customTemplates.apply || {};

    // 2. Construct WhatsApp Message (exact template requested by user)
    let waMessage = "";
    if (applyTemplates.whatsapp) {
      waMessage = replaceVars(applyTemplates.whatsapp, templateVars);
    } else {
      waMessage = `Merhaba Sayın ${fullName}, 🌟\n\nAbonelik başvuru bilgileriniz ve yüklediğiniz belgeler yetkililerimizce kontrol edilmek üzere başarıyla teslim alınmıştır! Yapılacak hızlı kontrollerin ardından aboneliğiniz onaylanacaktır. Başvuru detaylarınız aşağıda yer almaktadır:\n\n📦 Başvuru Kodu: ${mockAppId}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${parkingLocation}\n💸 Ücret: ${price}\n📞 Destek Telefonu: ${supportPhone}\n\n💳 Ödeme ve Dekont Bilgilendirmesi:\nYüklemiş olduğunuz ödeme dekontunuz ve başvuru bilgileriniz yetkililerimiz tarafından incelenmek üzere teslim alınmıştır. Kontroller tamamlanıp başvurunuz onaylandığında plaka tanıma sistemimiz otomatik olarak aktifleşecektir.\n\nBanka: ${bankName}\nIBAN: ${iban}\nAlıcı: ${companyTitle}`;
    }

    // 3. Send WhatsApp
    let waSuccess = false;
    let waError = null;
    try {
      const waResult = await sendWhatsApp(testPhone, waMessage, context.env);
      waSuccess = waResult.success !== false;
      if (!waSuccess) waError = waResult.error;
    } catch (e) {
      waError = e.message;
    }

    // Send SMS Test
    let smsSuccess = false;
    let smsError = null;
    try {
      let smsMessage = "";
      if (applyTemplates.sms) {
        smsMessage = replaceVars(applyTemplates.sms, templateVars);
      } else {
        smsMessage = `Bu bir test mesajidir. Takip No: ${mockAppId}. PARKEXPERT`;
      }
      const smsResult = await sendSMS(testPhone, smsMessage, context.env, scheduledDate, flashSms, "0", parkingLocation);
      smsSuccess = smsResult.success !== false;
      if (!smsSuccess) smsError = smsResult.error;
    } catch (e) {
      smsError = e.message;
    }

    // 4. Construct Email HTML
    let emailSubject = "";
    let emailHtml = "";
    
    if (applyTemplates.email_subject) {
      emailSubject = replaceVars(applyTemplates.email_subject, templateVars);
    } else {
      emailSubject = `🌟 PARKEXPERT Abonelik Başvurunuz Alındı! (Takip No: ${mockAppId})`;
    }

    if (applyTemplates.email_html) {
      emailHtml = replaceVars(applyTemplates.email_html, templateVars);
    } else {
      emailHtml = `
        <h2 style="font-size: 1.25rem; color: #0f3ba2; font-weight: 700; margin-top: 0; margin-bottom: 1rem; text-align: center;">Sayın ${fullName},</h2>
        
        <p style="font-size: 0.95rem; line-height: 1.6; color: #334155; margin-bottom: 1.5rem; text-align: center;">
          Bu bir <strong>TEST MESAJIDIR</strong>. Abonelik başvuru kaydınız başarıyla veri tabanımıza kaydedilmiştir. Plaka tanıma sistemi entegrasyonu ve yüklemiş olduğunuz belgeler ekiplerimiz tarafından incelenmektedir.
        </p>

        <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #0f3ba2; border: 1px solid #e2e8f0; border-left-width: 4px;">
          <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Başvuru Detayları (TEST)</h4>
          <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
            <div style="margin-bottom: 0.25rem;"><strong>Takip Numarası:</strong> <span style="color: #0f3ba2; font-weight: 700;">${mockAppId}</span></div>
            <div style="margin-bottom: 0.25rem;"><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: #334155;">${plateNumber}</span></div>
            <div style="margin-bottom: 0.25rem;"><strong>Otopark Konumu:</strong> <span>${parkingLocation}</span></div>
            <div style="margin-bottom: 0.25rem;"><strong>Abonelik Tipi:</strong> <span>${subscriptionType}</span></div>
          </div>
        </div>

        <div style="background: rgba(15, 59, 162, 0.05); border: 1px dashed #0f3ba2; border-radius: 8px; padding: 1rem; font-size: 0.85rem; line-height: 1.5; color: #0f3ba2; margin-bottom: 1.5rem;">
          <strong>Ödeme ve Hesap Bilgileri:</strong><br>
          Banka: ${bankName}<br>
          IBAN: ${iban}<br>
          Alıcı Unvanı: ${companyTitle}<br>
          Ücret: ${price} TL
        </div>
      `;
    }

    // 5. Send Email
    let emailSuccess = false;
    let emailError = null;
    try {
      const emailResult = await sendEmail({ to: testEmail, subject: emailSubject, html: emailHtml, env: context.env });
      emailSuccess = emailResult.success !== false;
      if (!emailSuccess) emailError = emailResult.error;
    } catch (e) {
      emailError = e.message;
    }

    return new Response(JSON.stringify({ 
      success: true, 
      mockAppId,
      whatsapp: { success: waSuccess, error: waError },
      email: { success: emailSuccess, error: emailError },
      sms: { success: smsSuccess, error: smsError }
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
