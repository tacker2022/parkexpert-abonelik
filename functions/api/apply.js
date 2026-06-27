import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";
import { sendSMS } from "./sms_helper.js";

// Helper to mask first and last name for privacy compliance
function maskName(name) {
  if (!name) return "";
  return name.trim().split(/\s+/).map(word => {
    if (!word) return "";
    if (word.length <= 2) return word;
    return word.substring(0, 2) + "*".repeat(word.length - 2);
  }).filter(Boolean).join(" ");
}

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const allowOrigin = (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:") || origin === "https://parkexpertabonelik.net")
    ? origin
    : "https://parkexpertabonelik.net";

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
  const bucket = context.env.BUCKET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!bucket) {
    return new Response(JSON.stringify({ error: "Missing Cloudflare R2 Bucket binding" }), { status: 500, headers });
  }

  try {
    const formData = await context.request.formData();

    const appId = formData.get("id");
    const fullName = formData.get("full_name");
    const email = formData.get("email");
    const phone = formData.get("phone");
    const plateNumber = formData.get("plate_number");
    const parkingLocation = formData.get("parking_location");
    const companyName = formData.get("company_name") || null;
    const taxOffice = formData.get("tax_office") || null;
    const taxNumber = formData.get("tax_number") || null;
    const subscriptionType = formData.get("subscription_type");
    
    // Additional fields
    const tcNo = formData.get("tc_no") || null;
    const carModel = formData.get("car_model") || null;
    const driverName = formData.get("driver_name") || null;
    const homeAddress = formData.get("home_address") || null;
    const notes = formData.get("notes") || null;
    const dateApplied = formData.get("date_applied") || new Date().toISOString();

    if (!appId || !fullName || !email || !phone || !plateNumber || !parkingLocation || !subscriptionType) {
      return new Response(JSON.stringify({ error: "Missing required text fields" }), { status: 400, headers });
    }

    // Verify Cloudflare Turnstile token
    const turnstileResponse = formData.get("cf-turnstile-response");
    if (!turnstileResponse) {
      return new Response(JSON.stringify({ error: "Güvenlik doğrulama kodu bulunamadı." }), { status: 400, headers });
    }

    const turnstileSecret = context.env.TURNSTILE_SECRET || "1x00000000000000000000000000000000";
    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        secret: turnstileSecret,
        response: turnstileResponse,
        remoteip: context.request.headers.get("CF-Connecting-IP") || ""
      })
    });

    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return new Response(JSON.stringify({ error: "Güvenlik doğrulaması (Turnstile) başarısız oldu! Lütfen sayfayı yenileyip tekrar deneyin." }), { status: 400, headers });
    }

    // Helper function to upload file to R2
    const uploadToR2 = async (file, fieldName) => {
      if (!file || typeof file === "string" || file.size === 0) return null;
      const ext = file.name ? file.name.split(".").pop() : "pdf";
      const path = `applications/${appId}/${fieldName}.${ext}`;
      await bucket.put(path, file, {
        httpMetadata: {
          contentType: file.type || "application/octet-stream"
        }
      });
      return path;
    };

    // Upload files
    const ruhsatFile = formData.get("ruhsat");
    const kimlikFile = formData.get("kimlik");
    const dekontFile = formData.get("dekont");
    const vergiFile = formData.get("vergi");
    const sirkulerFile = formData.get("sirkuler");
    const calismaFile = formData.get("calisma");

    const ruhsatUrl = await uploadToR2(ruhsatFile, "ruhsat");
    const kimlikUrl = await uploadToR2(kimlikFile, "kimlik");
    const dekontUrl = await uploadToR2(dekontFile, "dekont");
    const vergiUrl = await uploadToR2(vergiFile, "vergi");
    const sirkulerUrl = await uploadToR2(sirkulerFile, "sirkuler");
    const calismaUrl = await uploadToR2(calismaFile, "calisma");

    if (!ruhsatUrl || !kimlikUrl || !dekontUrl) {
      return new Response(JSON.stringify({ error: "Missing required files (ruhsat, kimlik or dekont)" }), { status: 400, headers });
    }

    // Check if otopark requires management approval
    let managementApprovalStatus = "İzin Verildi";
    try {
      const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?name=eq.${encodeURIComponent(parkingLocation)}&select=requires_management_approval`, {
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
      console.error("Error checking requires_management_approval:", e);
    }

    // Insert record into Supabase
    const payload = {
      id: appId,
      full_name: fullName,
      email: email,
      phone: phone,
      plate_number: plateNumber,
      parking_location: parkingLocation,
      company_name: companyName,
      tax_office: taxOffice,
      tax_number: taxNumber,
      subscription_type: subscriptionType,
      status: "Beklemede",
      management_approval: managementApprovalStatus,
      ruhsat_url: ruhsatUrl,
      kimlik_url: kimlikUrl,
      dekont_url: dekontUrl,
      vergi_url: vergiUrl,
      sirkuler_url: sirkulerUrl,
      calisma_url: calismaUrl,
      tc_no: tcNo,
      car_model: carModel,
      driver_name: driverName,
      home_address: homeAddress,
      notes: notes,
      date_applied: dateApplied
    };

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
      return new Response(JSON.stringify({ error: `Supabase error: ${errText}` }), { status: res.status, headers });
    }

    const data = await res.json();

    // Trigger notifications asynchronously in the background
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

          // 2. Fetch Otopark details
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

          const bankName = park.bank_name || "Vakıfbank";
          const iban = park.iban || "TR23 0001 5001 5800 7302 9104 88";
          const companyTitle = park.company_title || "PARKEXPERT";
          const isBirlikSanayi = parkingLocation === "Birlik Sanayi Sitesi - Beylikdüzü";
          const price = (subscriptionType.includes("Kurumsal") && !isBirlikSanayi) 
            ? (park.price_external || "2400 TL") 
            : (park.price_employee || "1200 TL");
          const supportPhone = park.support_phone || "0216 504 47 22";

          const templateVars = {
            fullName,
            appId,
            plateNumber,
            parkingLocation,
            subscriptionType,
            price,
            supportPhone,
            bankName,
            iban,
            companyTitle,
            carModel: carModel || 'Belirtilmedi'
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

          // 3. Dispatch WhatsApp Notification if enabled
          if (settings.whatsapp_enabled) {
            let message = "";
            if (applyTemplates.whatsapp) {
              message = replaceVars(applyTemplates.whatsapp, templateVars);
            } else {
              message = `Merhaba Sayın ${fullName}, 🌟\n\nAbonelik başvuru bilgileriniz ve yüklediğiniz belgeler yetkililerimizce kontrol edilmek üzere başarıyla teslim alınmıştır! Yapılacak hızlı kontrollerin ardından aboneliğiniz onaylanacaktır. Başvuru detaylarınız aşağıda yer almaktadır:\n\n📦 Başvuru Kodu: ${appId}\n🚗 Araç Plakası: ${plateNumber}\n📍 Otopark Konumu: ${parkingLocation}\n💸 Ücret: ${price}\n📞 Destek Telefonu: ${supportPhone}\n\n💳 Ödeme ve Dekont Bilgilendirmesi:\nYüklemiş olduğunuz ödeme dekontunuz ve başvuru bilgileriniz yetkililerimiz tarafından incelenmek üzere teslim alınmıştır. Kontroller tamamlanıp başvurunuz onaylandığında plaka tanıma sistemimiz otomatik olarak aktifleşecektir.\n\nBanka: ${bankName}\nIBAN: ${iban}\nAlıcı: ${companyTitle}`;
            }
            await sendWhatsApp(phone, message, context.env);
          }

          // 4. Dispatch Email Notification if enabled
          if (settings.email_enabled) {
            let emailSubject = "";
            let emailHtml = "";

            if (applyTemplates.email_subject) {
              emailSubject = replaceVars(applyTemplates.email_subject, templateVars);
            } else {
              emailSubject = `🌟 PARKEXPERT Abonelik Başvurunuz Alındı! (Takip No: ${appId})`;
            }

            if (applyTemplates.email_html) {
              emailHtml = replaceVars(applyTemplates.email_html, templateVars);
            } else {
              emailHtml = `
                <h2 style="font-size: 1.25rem; color: #0f3ba2; font-weight: 700; margin-top: 0; margin-bottom: 1rem; text-align: center;">Sayın ${fullName},</h2>
                
                <p style="font-size: 0.95rem; line-height: 1.6; color: #334155; margin-bottom: 1.5rem; text-align: center;">
                  Abonelik başvuru kaydınız başarıyla veri tabanımıza kaydedilmiştir. Plaka tanıma sistemi entegrasyonu ve yüklemiş olduğunuz belgeler ekiplerimiz tarafından incelenmektedir.
                </p>

                <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #0f3ba2; border: 1px solid #e2e8f0; border-left-width: 4px;">
                  <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Başvuru Detayları</h4>
                  <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
                    <div style="margin-bottom: 0.25rem;"><strong>Takip Numarası:</strong> <span style="color: #0f3ba2; font-weight: 700;">${appId}</span></div>
                    <div style="margin-bottom: 0.25rem;"><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: 700; color: #334155;">${plateNumber}</span></div>
                    <div style="margin-bottom: 0.25rem;"><strong>Otopark Konumu:</strong> <span>${parkingLocation}</span></div>
                    <div style="margin-bottom: 0.25rem;"><strong>Abonelik Tipi:</strong> <span>${subscriptionType}</span></div>
                    <div style="margin-bottom: 0.25rem;"><strong>Ücret:</strong> <span>${price}</span></div>
                    <div style="margin-bottom: 0.25rem;"><strong>Araç Modeli:</strong> <span>${carModel || 'Belirtilmedi'}</span></div>
                  </div>
                </div>

                <div style="background: #f8fafc; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; border-left: 4px solid #eab308; border: 1px solid #e2e8f0; border-left-width: 4px;">
                  <h4 style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-top: 0; margin-bottom: 0.75rem; font-weight: 700;">Ödeme ve Dekont Bilgileri</h4>
                  <p style="font-size: 0.875rem; margin: 0 0 0.5rem 0; color: #334155;">Aboneliğinizin aktifleşmesi için aşağıdaki IBAN adresine havale/EFT yapıp dekontunuzu yüklediğinizden emin olunuz:</p>
                  <div style="font-size: 0.875rem; color: #334155; line-height: 1.5;">
                    <div><strong>Banka:</strong> ${bankName}</div>
                    <div><strong>IBAN:</strong> <code style="background: #e2e8f0; padding: 0.1rem 0.3rem; border-radius: 4px; font-family: monospace;">${iban}</code></div>
                    <div><strong>Alıcı:</strong> ${companyTitle}</div>
                    <div style="margin-top: 0.5rem; font-weight: 600; color: #b45309;">AÇIKLAMA KISMINA PLAKA VE ABONE BİLGİSİ YAZMAYI UNUTMAYINIZ!</div>
                  </div>
                </div>

                <div style="background: rgba(15, 59, 162, 0.05); border: 1px dashed #0f3ba2; border-radius: 8px; padding: 1rem; font-size: 0.85rem; line-height: 1.5; color: #1e3a8a;">
                  Başvurunuz onaylandığında plaka tanıma sistemimiz otomatik olarak aktif edilecek ve tarafınıza <strong>E-posta</strong> ve <strong>WhatsApp</strong> ile bilgilendirme yapılacaktır. Takip numaranız ile istediğiniz an durum sorgulaması yapabilirsiniz.
                </div>
              `;
            }
            await sendEmail({ to: email, subject: emailSubject, html: emailHtml, env: context.env });
          }

          if (park.notification_emails) {
            const maskedFullName = maskName(fullName);
            const adminSubject = `🚨 [YENİ BAŞVURU] ${parkingLocation} - ${maskedFullName} (${plateNumber})`;
            const adminHtml = `
              <h3 style="color: #0f3ba2; margin-top: 0;">🚨 Yeni Abonelik Başvurusu Alındı!</h3>
              <p><strong>Otopark Konumu:</strong> ${parkingLocation}</p>
              <div style="background: #f8fafc; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; border: 1px solid #e2e8f0; border-left: 4px solid #0f3ba2;">
                <div style="font-size: 0.9rem; line-height: 1.6; color: #334155;">
                  <div><strong>Müşteri Ad Soyad:</strong> ${maskedFullName}</div>
                  <div><strong>Araç Plakası:</strong> <span style="text-transform: uppercase; font-weight: bold;">${plateNumber}</span></div>
                  <div><strong>Abonelik Tipi:</strong> ${subscriptionType}</div>
                  <div><strong>Takip No:</strong> <span style="font-family: monospace; font-weight: bold; color: #0f3ba2;">${appId}</span></div>
                  <div><strong>Telefon:</strong> ${phone}</div>
                  <div><strong>E-posta:</strong> ${email}</div>
                  <div><strong>Araç Marka/Model:</strong> ${carModel || 'Belirtilmedi'}</div>
                </div>
              </div>
              <p style="font-size: 0.85rem; color: #64748b;">Başvuru evraklarını kontrol etmek ve onay/ret işlemini gerçekleştirmek için lütfen <a href="https://parkexpertabonelik.net/admin" style="color: #0f3ba2; font-weight: bold; text-decoration: none;">Yönetici Paneli</a>'ne giriş yapınız.</p>
            `;
            
            await sendEmail({
              to: park.notification_emails,
              subject: adminSubject,
              html: adminHtml,
              env: context.env
            });
          }

          // 5. Dispatch SMS Notification if enabled
          if (settings.sms_enabled) {
            let smsMessage = "";
            if (applyTemplates.sms) {
              smsMessage = replaceVars(applyTemplates.sms, templateVars);
            } else {
              smsMessage = `Sayın ${fullName}, ${parkingLocation} otopark abonelik başvurunuz alınmıştır. Takip No: ${appId}. Evraklarınız incelenmektedir. PARKEXPERT`;
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

            await sendSMS(phone, smsMessage, context.env, scheduledSMSDate, settings.flash_sms, "0", parkingLocation);
          }
        } catch (waErr) {
          console.error("Failed to send notifications on apply:", waErr);
        }
      })()
    );

    return new Response(JSON.stringify({ success: true, data }), { status: 201, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
