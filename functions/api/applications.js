import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";
import { sendSMS } from "./sms_helper.js";
import { logAudit } from "./audit_helper.js";

// Helper for safe base64 decoding (supports Unicode)
function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Helper to verify JWT token using HMAC-SHA256
async function verifyToken(token, secret, clientIp, supabaseUrl, supabaseAnonKey) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payloadStr = base64Decode(parts[0]);
    const signatureHex = parts[1];

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
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
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;
  const bucket = context.env.BUCKET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  // Authenticate Request
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
  const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
  if (!user) {
    return new Response(JSON.stringify({ error: "Geçersiz oturum! Lütfen tekrar giriş yapın." }), { status: 401, headers });
  }

  const method = context.request.method;

  try {
    // ----------------------------------------------------
    // GET: List applications (Filtered by Role)
    // ----------------------------------------------------
    if (method === "GET") {
      let queryUrl = `${supabaseUrl}/rest/v1/applications?select=*&order=created_at.desc`;

      if (user.role !== "superadmin") {
        const allowedOtoparks = user.otoparks || [];
        if (allowedOtoparks.length === 0) {
          return new Response(JSON.stringify([]), { status: 200, headers });
        }
        // Format in.(...) parameter. Wrapping each otopark name in double quotes for safe parser matching
        const formattedOtoparks = allowedOtoparks.map(name => `"${name}"`).join(",");
        queryUrl = `${supabaseUrl}/rest/v1/applications?parking_location=in.(${encodeURIComponent(formattedOtoparks)})&select=*&order=created_at.desc`;
      }

      const res = await fetch(queryUrl, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Supabase error: ${errText}` }), { status: res.status, headers });
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    // ----------------------------------------------------
    // PATCH: Update application status (Approved / Rejected)
    // ----------------------------------------------------
    if (method === "PATCH") {
       const requestData = await context.request.json();
      const { id, status, plate_number, company_name, subscription_expires_at, management_approval } = requestData;
      if (!id) {
        return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers });
      }

      // Check access: Fetch application first
      const getRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${id}&select=parking_location,status,plate_number,company_name,subscription_expires_at,full_name,management_approval`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!getRes.ok) {
        return new Response(JSON.stringify({ error: "Application not found" }), { status: 404, headers });
      }

      const apps = await getRes.json();
      if (apps.length === 0) {
        return new Response(JSON.stringify({ error: "Application not found" }), { status: 404, headers });
      }

      const oldApp = apps[0];
      const appLocation = oldApp.parking_location;

      // Access verification
      if (user.role !== "superadmin" && !user.otoparks.includes(appLocation)) {
        return new Response(JSON.stringify({ error: "Bu otoparkın verisini güncelleme yetkiniz yok!" }), { status: 403, headers });
      }

      // Fetch otopark configuration to see if it requires management approval
      const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(appLocation)}&select=requires_management_approval`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      let requiresManagement = false;
      if (otoparkRes.ok) {
        const otoparksArr = await otoparkRes.json();
        if (otoparksArr.length > 0) {
          requiresManagement = otoparksArr[0].requires_management_approval === true;
        }
      }

      // Build dynamic update body
      const updateBody = {};

      if (user.role === "yonetim" || user.role === "yonetim_avm" || user.role === "yonetim_site") {
        // Management role can only update management_approval
        if (status !== undefined || plate_number !== undefined || company_name !== undefined || subscription_expires_at !== undefined) {
          return new Response(JSON.stringify({ error: "Yönetim yetkisi bu alanları değiştiremez!" }), { status: 403, headers });
        }
        if (management_approval !== undefined) {
          updateBody.management_approval = management_approval;
          if (management_approval === "Reddedildi") {
            updateBody.status = "Reddedildi";
          }
        }
      } else {
        // Admin or Superadmin
        const currentApproval = management_approval !== undefined ? management_approval : (oldApp.management_approval || "Beklemede");
        if (status === "Onaylandı" && requiresManagement && currentApproval === "Beklemede") {
          return new Response(JSON.stringify({ error: "Yönetim onayı verilmemiş bir başvuru onaylanamaz!" }), { status: 400, headers });
        }

        if (status !== undefined) {
          updateBody.status = status;
          if (status === "Onaylandı") {
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + 30);
            updateBody.subscription_expires_at = expiryDate.toISOString();
          }
        }
        if (plate_number !== undefined) updateBody.plate_number = plate_number;
        if (company_name !== undefined) updateBody.company_name = company_name;
        if (subscription_expires_at !== undefined) updateBody.subscription_expires_at = subscription_expires_at;
        if (management_approval !== undefined) {
          updateBody.management_approval = management_approval;
          if (management_approval === "Beklemede") {
            updateBody.status = "Beklemede";
            updateBody.subscription_expires_at = null;
          } else if (management_approval === "Reddedildi") {
            updateBody.status = "Reddedildi";
          }
        }
      }

      // Update in Supabase
      const updateRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify(updateBody)
      });

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        return new Response(JSON.stringify({ error: `Supabase update error: ${errText}` }), { status: updateRes.status, headers });
      }

      const updatedData = await updateRes.json();

      // Log audit action
      if (updatedData && updatedData.length > 0) {
        const updatedApp = updatedData[0];
        let auditActionType = "edit_application";
        let auditDetails = `Başvuru #${id} (${updatedApp.full_name || ''}) güncellendi:`;
        const detailParts = [];
        
        if (status !== undefined && oldApp.status !== status) {
          if (status === "Onaylandı") {
            auditActionType = "approve_app";
          } else if (status === "Reddedildi") {
            auditActionType = "reject_app";
          } else {
            auditActionType = "update_status";
          }
          detailParts.push(`Durum: "${oldApp.status || 'Belirsiz'}" ➔ "${status}".`);
        }
        
        if (subscription_expires_at !== undefined || (status === "Onaylandı" && updateBody.subscription_expires_at)) {
          if (status !== "Onaylandı") {
            auditActionType = "extend_subscription";
          }
          const oldDate = oldApp.subscription_expires_at ? oldApp.subscription_expires_at.substring(0, 10) : "Tanımsız";
          const newDate = updateBody.subscription_expires_at ? updateBody.subscription_expires_at.substring(0, 10) : "Tanımsız";
          if (oldDate !== newDate) {
            detailParts.push(`Bitiş Tarihi: ${oldDate} ➔ ${newDate}.`);
          }
        }
        if (management_approval !== undefined && oldApp.management_approval !== management_approval) {
          if (auditActionType === "edit_application") {
            if (management_approval === "İzin Verildi") {
              auditActionType = "management_approve";
            } else if (management_approval === "Reddedildi") {
              auditActionType = "management_reject";
            }
          }
          detailParts.push(`Yönetim Onayı: "${oldApp.management_approval || 'Beklemede'}" ➔ "${management_approval}".`);
        }
        if (plate_number !== undefined && oldApp.plate_number !== plate_number) {
          detailParts.push(`Plaka: "${oldApp.plate_number || ''}" ➔ "${plate_number}".`);
        }
        if (company_name !== undefined && oldApp.company_name !== company_name) {
          detailParts.push(`Firma adı: "${oldApp.company_name || ''}" ➔ "${company_name}".`);
        }

        if (detailParts.length > 0) {
          auditDetails += " " + detailParts.join(" ");
        } else {
          auditDetails += " (Değişiklik yapılmadı veya şifre güncellendi)";
        }
        
        const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";

        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: auditActionType,
            targetId: id,
            details: auditDetails,
            ipAddress
          })
        );
      }

      // Trigger status notifications asynchronously in the background
      if (updatedData && updatedData.length > 0) {
        const updatedApp = updatedData[0];
        context.waitUntil(
          (async () => {
            try {
              // 1. Fetch System Settings / Notification Toggles
              const settingsRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.notification_toggles&select=*`, {
                headers: {
                  "apikey": supabaseAnonKey,
                  "Authorization": `Bearer ${supabaseAnonKey}`
                }
              });
              
              let settings = { email_enabled: true, whatsapp_enabled: true, sms_enabled: true };
              if (settingsRes.ok) {
                const rows = await settingsRes.json();
                if (rows.length > 0) {
                  settings = rows[0].value;
                }
              }

              const fullName = updatedApp.full_name;
              const phone = updatedApp.phone;
              const plateNumber = updatedApp.plate_number;
              const appLocation = updatedApp.parking_location;

              const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(appLocation)}&select=*`, {
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

              const supportPhone = park.support_phone || "0216 504 47 22";
              const bankName = park.bank_name || "Vakıfbank";
              const iban = park.iban || "TR23 0001 5001 5800 7302 9104 88";
              const companyTitle = park.company_title || "PARKEXPERT";
              const isBirlikSanayi = park.id === "birlik-sanayi";
              const price = (updatedApp.subscription_type?.includes("Kurumsal") && !isBirlikSanayi && !park.apply_employee_price_to_corporate) 
                ? (park.price_external || "2400 TL") 
                : (park.price_employee || "1200 TL");

              const templateVars = {
                fullName,
                appId: id,
                plateNumber,
                parkingLocation: appLocation,
                subscriptionType: updatedApp.subscription_type || "",
                price,
                supportPhone,
                bankName,
                iban,
                companyTitle,
                carModel: updatedApp.car_model || 'Belirtilmedi'
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
              const approveTemplates = customTemplates.approve || {};
              const rejectTemplates = customTemplates.reject || {};

              // 2. Dispatch WhatsApp Notification if enabled
              if (settings.whatsapp_enabled) {
                let message = "";
                if (status === "Onaylandı") {
                  if (approveTemplates.whatsapp) {
                    message = replaceVars(approveTemplates.whatsapp, templateVars);
                  } else {
                    message = `Merhaba Sayın ${fullName}, 🌟\n\nAbonelik başvuru evraklarınız ve ödeme dekontunuz başarıyla incelenmiş ve ONAYLANMIŞTIR. Aboneliğiniz aktif edilmiştir! Detaylar aşağıda yer almaktadır:\n\n📦 Başvuru Kodu: ${id}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${appLocation}\n💸 Abonelik Tipi: ${updatedApp.subscription_type}\n📞 Destek Telefonu: ${supportPhone}\n\n🚗 HGS Otomatik Geçiş Bilgilendirmesi:\nPlaka tanıma sistemimiz plakanızı otomatik olarak veritabanına tanımlamıştır. Otopark giriş ve çıkışlarında HGS (Hızlı Geçiş Sistemi) plakanızı okuyarak geçiş izni verecektir. Herhangi bir kart okutmanıza veya bilet almanıza gerek yoktur. Keyifli sürüşler dileriz!`;
                  }
                } else if (status === "Reddedildi") {
                  if (rejectTemplates.whatsapp) {
                    message = replaceVars(rejectTemplates.whatsapp, templateVars);
                  } else {
                    message = `Merhaba Sayın ${fullName}, ⚠️\n\nAbonelik ön başvurunuz, yüklenen belgelerdeki (ruhsat/kimlik) eksiklikler veya ödeme dekontunun doğrulanamaması nedeniyle REDDEDİLMİŞTIR.\n\n📦 Başvuru Kodu: ${id}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${appLocation}\n⚠️ Durum: Belge Eksikliği / Dekont Hatası\n\n💬 Nasıl Düzeltebilirsiniz?\nLütfen bilgilerinizi kontrol edip belgeleri yeniden yükleyerek yeni bir başvuru oluşturunuz veya otopark yönetim ofisimizle iletişime geçiniz: ${supportPhone}`;
                  }
                }
                if (message) {
                  await sendWhatsApp(phone, message, context.env);
                }
              }

              // 3. Dispatch Email Notification if enabled
              if (settings.email_enabled && (status === "Onaylandı" || status === "Reddedildi")) {
                let emailSubject = "";
                let emailHtml = "";

                if (status === "Onaylandı") {
                  if (approveTemplates.email_subject) {
                    emailSubject = replaceVars(approveTemplates.email_subject, templateVars);
                  } else {
                    emailSubject = `🎉 PARKEXPERT Abonelik Başvurunuz ONAYLANDI! (Takip No: ${id})`;
                  }

                  if (approveTemplates.email_html) {
                    emailHtml = replaceVars(approveTemplates.email_html, templateVars);
                  } else {
                    emailHtml = `
                      <h2 style="font-size: 1.25rem; color: #10b981; font-weight: 700; margin-top: 0; margin-bottom: 1rem; text-align: center;">Sayın ${fullName},</h2>
                      
                      <p style="font-size: 0.95rem; line-height: 1.6; color: #334155; margin-bottom: 1.5rem; text-align: center;">
                        Abonelik başvuru evraklarınız ve ödeme dekontunuz ekiplerimiz tarafından doğrulanmış ve <strong>ONAYLANMIŞTIR</strong>. Plaka tanıma sistemimiz aktif edilmiştir.
                      </p>

                      <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #10b981; border: 1px solid #e2e8f0; border-left-width: 4px;">
                        <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Onaylanan Abonelik Detayları</h4>
                        <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
                          <div style="margin-bottom: 0.25rem;"><strong>Takip Numarası:</strong> <span style="color: #0f3ba2; font-weight: 700;">${id}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: #334155;">${plateNumber}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Otopark Konumu:</strong> <span>${appLocation}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Abonelik Tipi:</strong> <span>${updatedApp.subscription_type}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Durum:</strong> <span style="color: #10b981; font-weight: 700;">Aktif / Onaylandı</span></div>
                        </div>
                      </div>

                      <div style="background: rgba(16, 185, 129, 0.05); border: 1px dashed #10b981; border-radius: 8px; padding: 1rem; font-size: 0.85rem; line-height: 1.5; color: #065f46;">
                        <strong>HGS / Otomatik Geçiş Bilgilendirmesi:</strong><br>
                        Otopark giriş ve çıkışlarında plaka tanıma HGS (Hızlı Geçiş Sistemi) plakanızı otomatik olarak okuyacak ve geçiş izni verecektir. Bilet almanıza veya kart kullanmanıza gerek yoktur. Keyifli sürüşler dileriz!
                      </div>
                    `;
                  }
                } else if (status === "Reddedildi") {
                  if (rejectTemplates.email_subject) {
                    emailSubject = replaceVars(rejectTemplates.email_subject, templateVars);
                  } else {
                    emailSubject = `⚠️ PARKEXPERT Abonelik Başvurunuz Hakkında (Takip No: ${id})`;
                  }

                  if (rejectTemplates.email_html) {
                    emailHtml = replaceVars(rejectTemplates.email_html, templateVars);
                  } else {
                    emailHtml = `
                      <h2 style="font-size: 1.25rem; color: #ef4444; font-weight: 700; margin-top: 0; margin-bottom: 1rem; text-align: center;">Sayın ${fullName},</h2>
                      
                      <p style="font-size: 0.95rem; line-height: 1.6; color: #334155; margin-bottom: 1.5rem; text-align: center;">
                        Abonelik ön başvurunuz, yüklenen belgelerdeki (ruhsat/kimlik) eksiklikler veya ödeme dekontunun uyuşmaması nedeniyle <strong>REDDEDİLMİŞTİR</strong>.
                      </p>

                      <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #ef4444; border: 1px solid #e2e8f0; border-left-width: 4px;">
                        <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Reddedilen Başvuru Detayları</h4>
                        <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
                          <div style="margin-bottom: 0.25rem;"><strong>Takip Numarası:</strong> <span style="color: #0f3ba2; font-weight: 700;">${id}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: #334155;">${plateNumber}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Otopark Konumu:</strong> <span>${appLocation}</span></div>
                          <div style="margin-bottom: 0.25rem;"><strong>Durum:</strong> <span style="color: #ef4444; font-weight: 700;">Reddedildi / Evrak Eksikliği</span></div>
                        </div>
                      </div>

                      <div style="background: rgba(239, 68, 68, 0.05); border: 1px dashed #ef4444; border-radius: 8px; padding: 1rem; font-size: 0.85rem; line-height: 1.5; color: #991b1b;">
                        <strong>Nasıl Düzeltebilirsiniz?</strong><br>
                        Lütfen belgelerinizi, plaka numaranızı veya dekont bilgilerinizi kontrol ederek doğru belgelerle yeni bir abonelik başvurusu oluşturunuz ya da destek hattımız ile iletişime geçiniz: <strong>${supportPhone}</strong>
                      </div>
                    `;
                  }
                }

                await sendEmail({ to: updatedApp.email, subject: emailSubject, html: emailHtml, env: context.env });
              }

              // 4. Dispatch SMS Notification if enabled
              if (settings.sms_enabled) {
                let smsMessage = "";
                if (status === "Onaylandı") {
                  if (approveTemplates.sms) {
                    smsMessage = replaceVars(approveTemplates.sms, templateVars);
                  } else {
                    smsMessage = `Sayın ${fullName}, ${appLocation} otopark abonelik başvurunuz ONAYLANMIŞTIR. Plakanız otopark geçiş sistemine tanımlanmıştır. Keyifli sürüşler dileriz. PARKEXPERT`;
                  }
                } else if (status === "Reddedildi") {
                  if (rejectTemplates.sms) {
                    smsMessage = replaceVars(rejectTemplates.sms, templateVars);
                  } else {
                    smsMessage = `Sayın ${fullName}, ${appLocation} otopark abonelik başvurunuz belge veya ödeme hatası nedeniyle REDDEDİLMİŞTİR. Detaylar e-posta/WhatsApp ile iletilmiştir. PARKEXPERT`;
                  }
                }

                let scheduledSMSDate = null;
                if (settings.delay_night_sms) {
                  const nowUtc = new Date();
                  const turkeyTime = new Date(nowUtc.getTime() + (3 * 60 * 60 * 1000));
                  const hours = turkeyTime.getUTCHours();
                  if (hours >= 22 || hours < 8) {
                    const scheduledTurkey = new Date(turkeyTime);
                    if (hours >= 22) {
                      scheduledTurkey.setUTCDate(scheduledTurkey.getUTCDate() + 1);
                    }
                    scheduledTurkey.setUTCHours(9, 0, 0, 0);
                    scheduledSMSDate = new Date(scheduledTurkey.getTime() - (3 * 60 * 60 * 1000));
                  }
                }

                if (smsMessage) {
                  await sendSMS(phone, smsMessage, context.env, scheduledSMSDate, settings.flash_sms, "0", appLocation);
                }

                // Abonelik Bitiş Hatırlatma SMS'i Planla
                if (status === "Onaylandı" && settings.send_expiration_reminder) {
                  const reminderDays = settings.expiration_reminder_days || 3;
                  const targetDays = 30 - reminderDays;

                  const nowUtc = new Date();
                  const turkeyTime = new Date(nowUtc.getTime() + (3 * 60 * 60 * 1000));
                  const scheduledTurkey = new Date(turkeyTime);
                  scheduledTurkey.setUTCDate(scheduledTurkey.getUTCDate() + targetDays);
                  scheduledTurkey.setUTCHours(10, 0, 0, 0); // Sabah saat 10:00

                  const scheduledReminderDate = new Date(scheduledTurkey.getTime() - (3 * 60 * 60 * 1000));
                  const reminderMessage = `Sayın ${fullName}, ${appLocation} otopark aboneliğiniz ${reminderDays} gün sonra dolacaktır. Yenilemek için lütfen ödemenizi yapıp dekontunuzu sisteme yükleyiniz. PARKEXPERT`;

                  await sendSMS(phone, reminderMessage, context.env, scheduledReminderDate, settings.flash_sms, "0", appLocation);
                }
              }

              // 5. Mark reminder_logs as converted if application is approved or expiry is updated
              if (status === "Onaylandı" || subscription_expires_at !== undefined) {
                try {
                  const targetPlate = plate_number || updatedApp.plate_number || updatedApp.plate || "";
                  const filterQuery = `or=(application_id.eq.${id},plate_number.eq.${encodeURIComponent(targetPlate)})&converted=eq.false`;
                  await fetch(`${supabaseUrl}/rest/v1/reminder_logs?${filterQuery}`, {
                    method: "PATCH",
                    headers: {
                      "apikey": supabaseAnonKey,
                      "Authorization": `Bearer ${supabaseAnonKey}`,
                      "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                      converted: true,
                      converted_at: new Date().toISOString()
                    })
                  });
                } catch (convErr) {
                  console.error("Failed to mark reminder_logs as converted:", convErr);
                }
              }
            } catch (waErr) {
              console.error("Failed to send WhatsApp/Email/SMS message on status change:", waErr);
            }
          })()
        );
      }

      return new Response(JSON.stringify({ success: true, data: updatedData }), { status: 200, headers });
    }

    // ----------------------------------------------------
    // DELETE: Remove application & files (Super Admin Only)
    // ----------------------------------------------------
    if (method === "DELETE") {
      if (user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Sadece Süper Yönetici veri silebilir!" }), { status: 403, headers });
      }

      // Get appId from url query params, e.g. /api/applications?id=PE-123456
      const { searchParams } = new URL(context.request.url);
      const id = searchParams.get("id");

      if (!id) {
        return new Response(JSON.stringify({ error: "Missing application id" }), { status: 400, headers });
      }

      // Delete from Supabase
      let deleteRes;
      if (id.includes(",")) {
        deleteRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=in.(${id})`, {
          method: "DELETE",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`,
            "Prefer": "return=representation"
          }
        });
      } else {
        deleteRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${id}`, {
          method: "DELETE",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`,
            "Prefer": "return=representation"
          }
        });
      }

      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        return new Response(JSON.stringify({ error: `Supabase delete error: ${errText}` }), { status: deleteRes.status, headers });
      }

      // Delete documents from Cloudflare R2
      if (bucket) {
        const idList = id.split(",");
        for (const singleId of idList) {
          try {
            const listed = await bucket.list({ prefix: `applications/${singleId.trim()}/` });
            if (listed && listed.objects) {
              for (const obj of listed.objects) {
                await bucket.delete(obj.key);
              }
            }
          } catch (r2Err) {
            console.error("R2 Delete Error:", r2Err);
          }
        }
      }

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    // ----------------------------------------------------
    // POST: Create a test application (Superadmin only)
    // ----------------------------------------------------
    if (method === "POST") {
      if (user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Yalnızca süper yöneticiler test müşterisi oluşturabilir!" }), { status: 403, headers });
      }

      const requestData = await context.request.json();
      const { 
        subscription_type, 
        parking_location, 
        full_name, 
        plate_number, 
        phone, 
        email, 
        tc_identity, 
        brand_model, 
        subscription_period, 
        start_date 
      } = requestData;

      if (!parking_location || !full_name || !plate_number || !phone || !email) {
        return new Response(JSON.stringify({ error: "Eksik parametreler" }), { status: 400, headers });
      }

      // Generate a unique application ID starting with PE-
      const appId = "PE-" + Math.floor(100000 + Math.random() * 900000);

      // Check if otopark requires management approval
      let managementApprovalStatus = "İzin Verildi";
      try {
        const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(parking_location)}&select=requires_management_approval`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });
        if (otoparkRes.ok) {
          const parks = await otoparkRes.json();
          if (parks.length > 0 && parks[0].requires_management_approval === true) {
            managementApprovalStatus = "Beklemede";
          }
        }
      } catch (e) {
        console.error("Error checking requires_management_approval for test customer:", e);
      }

      const payload = {
        id: appId,
        full_name: full_name,
        email: email,
        phone: phone,
        plate_number: plate_number,
        parking_location: parking_location,
        subscription_type: subscription_type || "bireysel",
        status: "Beklemede",
        management_approval: managementApprovalStatus,
        tc_no: tc_identity || "11111111111",
        car_model: brand_model || "Test Aracı",
        notes: "Süper Admin tarafından oluşturulmuş test müşterisi.",
        date_applied: new Date().toISOString(),
        // Mock PDF/Images paths
        ruhsat_url: `applications/${appId}/ruhsat.pdf`,
        kimlik_url: `applications/${appId}/kimlik.pdf`,
        dekont_url: `applications/${appId}/dekont.pdf`
      };

      // Create empty mock files in R2 BUCKET so UI does not fail on viewing files
      if (bucket) {
        try {
          const emptyFile = new Uint8Array([0]);
          await bucket.put(`applications/${appId}/ruhsat.pdf`, emptyFile, { httpMetadata: { contentType: "application/pdf" } });
          await bucket.put(`applications/${appId}/kimlik.pdf`, emptyFile, { httpMetadata: { contentType: "application/pdf" } });
          await bucket.put(`applications/${appId}/dekont.pdf`, emptyFile, { httpMetadata: { contentType: "application/pdf" } });
        } catch (r2Err) {
          console.error("R2 Test File Upload Error:", r2Err);
        }
      }

      const res = await fetch(`${supabaseUrl}/rest/v1/applications`, {
        method: "POST",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Supabase insert error: ${errText}` }), { status: res.status, headers });
      }

      const data = await res.json();

      // Log audit
      const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
      context.waitUntil(
        logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "create_test_app",
          targetId: appId,
          details: `Test başvurusu #${appId} (${full_name}) oluşturuldu.`,
          ipAddress
        })
      );

      return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
