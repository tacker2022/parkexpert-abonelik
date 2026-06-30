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
      let totalApps = 0;
      let avgApprovalTimeText = "—";
      let trendStats = [];
      let maxCount = 1;
      let bannerHtml = "";
      let emailSubject = "";

      const tz = { timeZone: "Europe/Istanbul" };
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

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
        const parkApps = allApps.filter(app => app.parking_location === selectedParkingLocation);
        recentApps = parkApps.filter(app => app.date_applied && new Date(app.date_applied) >= yesterday);
        totalApps = parkApps.length;

        // Calculate average approval duration for applications approved in the last 24 hours
        const approvedRecent = parkApps.filter(app => {
          if (app.status !== 'Onaylandı' || !app.subscription_expires_at || !app.date_applied) return false;
          const approvedTime = new Date(app.subscription_expires_at).getTime() - (30 * 24 * 60 * 60 * 1000);
          return approvedTime >= yesterday.getTime();
        });

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

        // Calculate daily trend counts for the last 7 days
        const daysOfWeek = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dayStr = d.toLocaleDateString("tr-TR", tz);
          const dayLabel = `${d.getDate()} ${d.toLocaleDateString("tr-TR", { month: "short", timeZone: "Europe/Istanbul" })} ${daysOfWeek[d.getDay()]}`;
          
          const count = parkApps.filter(app => {
            if (!app.date_applied) return false;
            return new Date(app.date_applied).toLocaleDateString("tr-TR", tz) === dayStr;
          }).length;
          
          if (count > maxCount) maxCount = count;
          trendStats.push({ label: dayLabel, count });
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
        avgApprovalTimeText = "45 dakika";
        recentApps = [
          { id: "PE-TEST-X9Y2", full_name: "Ahmet Yılmaz", plate_number: "34ABC123", subscription_type: "Bireysel (1 Aylık)", date_applied: new Date().toISOString(), status: "Onaylandı" },
          { id: "PE-TEST-M4N8", full_name: "Mehmet Kaya", plate_number: "34XYZ789", subscription_type: "Kurumsal (3 Aylık)", date_applied: new Date().toISOString(), status: "Beklemede" },
          { id: "PE-TEST-K7L3", full_name: "Ayşe Demir", plate_number: "34KLM456", subscription_type: "Bireysel (6 Aylık)", date_applied: new Date().toISOString(), status: "Reddedildi" }
        ];

        const daysOfWeek = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
        const mockCounts = [2, 5, 3, 8, 4, 6, 3];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dayLabel = `${d.getDate()} ${d.toLocaleDateString("tr-TR", { month: "short", timeZone: "Europe/Istanbul" })} ${daysOfWeek[d.getDay()]}`;
          const count = mockCounts[6 - i];
          if (count > maxCount) maxCount = count;
          trendStats.push({ label: dayLabel, count });
        }

        bannerHtml = `
          <div style="border: 2px dashed #0f3ba2; padding: 12px; margin-bottom: 20px; background-color: #f8fafc; border-radius: 8px; text-align: center; font-family: sans-serif;">
            <strong style="color: #0f3ba2; font-size: 0.95rem;">⚠️ BU BİR TEST GÖNDERİMİDİR (MOCK)</strong><br>
            <span style="font-size: 0.8rem; color: #64748b;">Bu e-posta otopark ayarlarından "Test Raporu (Mock)" butonuna basılarak tetiklenmiştir.</span>
          </div>
        `;
        emailSubject = `📊 Günlük Başvuru Raporu (TEST) - ${parkName}`;
      }

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

      // Trend bar chart html
      let trendHtml = "";
      trendStats.forEach(stat => {
        const percent = maxCount > 0 ? Math.round((stat.count / maxCount) * 100) : 0;
        trendHtml += `
          <div style="display: flex; align-items: center; margin-bottom: 8px; font-size: 0.85rem;">
            <div style="width: 100px; color: #475569; font-weight: 600;">${stat.label}</div>
            <div style="flex-grow: 1; background: #e2e8f0; border-radius: 4px; height: 12px; margin: 0 12px; overflow: hidden; position: relative;">
              <div style="background: ${stat.count > 0 ? '#0f3ba2' : '#cbd5e1'}; height: 100%; border-radius: 4px; width: ${stat.count > 0 ? Math.max(8, percent) : 0}%;"></div>
            </div>
            <div style="width: 40px; text-align: right; font-weight: 700; color: #1e293b;">${stat.count}</div>
          </div>
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
        <div style="margin-bottom: 2rem; width: 100%; display: table; border-collapse: separate; border-spacing: 8px 0; font-family: sans-serif;">
          <div style="display: table-row;">
            <!-- Card 1: Son 24 Saat -->
            <div style="display: table-cell; background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 1rem; text-align: center; width: 33%;">
              <div style="font-size: 0.7rem; font-weight: 800; color: #b45309; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">⚡ SON 24 SAAT</div>
              <div style="font-size: 1.8rem; font-weight: 800; color: #d97706; line-height: 1.1;">${recentApps.length}</div>
              <div style="font-size: 0.65rem; color: #b45309; font-weight: 600; margin-top: 0.25rem;">Yeni Başvuru ${mode === 'mock' ? '(Mock)' : ''}</div>
            </div>
            
            <!-- Card 2: Toplam Başvuru -->
            <div style="display: table-cell; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 1rem; text-align: center; width: 33%;">
              <div style="font-size: 0.7rem; font-weight: 800; color: #1d4ed8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem;">📊 TÜM ZAMANLAR</div>
              <div style="font-size: 1.8rem; font-weight: 800; color: #2563eb; line-height: 1.1;">${totalApps}</div>
              <div style="font-size: 0.65rem; color: #1d4ed8; font-weight: 600; margin-top: 0.25rem;">Toplam Başvuru ${mode === 'mock' ? '(Mock)' : ''}</div>
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
          <h4 style="margin: 0 0 1rem 0; font-size: 0.9rem; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 0.35rem;">
            📈 Son 7 Günlük Başvuru Akışı ${mode === 'mock' ? '(Mock)' : ''}
          </h4>
          <div style="display: flex; flex-direction: column;">
            ${trendHtml}
          </div>
        </div>

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
