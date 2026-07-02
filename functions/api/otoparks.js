// Helper for safe base64 decoding (supports Unicode)
import { logAudit } from "./audit_helper.js";
import { sendTelegramAlert } from "./telegram_helper.js";
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
        return null;
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
  }

  const method = context.request.method;

  try {
    // ----------------------------------------------------
    // GET: List all otoparks (Public)
    // ----------------------------------------------------
    if (method === "GET") {
      const res = await fetch(`${supabaseUrl}/rest/v1/otoparks?is_deleted=eq.false&select=*&order=name.asc`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Supabase error: ${errText}` }), { status: res.status, headers });
      }

      const otoparks = await res.json();

      // Fetch companies to calculate counts per otopark
      const compRes = await fetch(`${supabaseUrl}/rest/v1/companies?select=otopark_name,rep_name`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });
      const companies = compRes.ok ? await compRes.json() : [];

      const enrichedData = otoparks.map(park => {
        const otoparkCompanies = companies.filter(c => c.otopark_name === park.name);
        const representativeCount = otoparkCompanies.filter(c => c.rep_name && c.rep_name.trim() !== '').length;
        return {
          ...park,
          company_count: otoparkCompanies.length,
          representative_count: representativeCount
        };
      });

      return new Response(JSON.stringify(enrichedData), { status: 200, headers });
    }

    // Authenticate for POST and DELETE (Super Admin Only)
    const authHeader = context.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Yetkisiz oturum!" }), { status: 401, headers });
    }

    const token = authHeader.substring(7);
    const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
    const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
    if (!user || user.role !== "superadmin") {
      return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
    }

    // ----------------------------------------------------
    // POST: Create or Update an otopark
    // ----------------------------------------------------
    if (method === "POST") {
      const payload = await context.request.json();
      const {
        id,
        name,
        category,
        companyTitle,
        taxOffice,
        taxNumber,
        bankName,
        iban,
        priceEmployee,
        priceExternal,
        supportPhone,
        isActive,
        templates,
        notificationEmails,
        summaryEmails,
        requiresManagementApproval,
        applyEmployeePriceToCorporate,
        allowIndividual,
        tariffs
      } = payload;

      if (!id) {
        if (!name || !category || !companyTitle || !taxOffice || !taxNumber || !bankName || !iban || !supportPhone) {
          return new Response(JSON.stringify({ error: "Lütfen zorunlu alanları doldurun." }), { status: 400, headers });
        }
      }

      let dbPayload = {};
      if (id) {
        // UPDATE: Partial update semantics
        if (name !== undefined) dbPayload.name = name;
        if (category !== undefined) dbPayload.category = category;
        if (companyTitle !== undefined) dbPayload.company_title = companyTitle;
        if (taxOffice !== undefined) dbPayload.tax_office = taxOffice;
        if (taxNumber !== undefined) dbPayload.tax_number = taxNumber;
        if (bankName !== undefined) dbPayload.bank_name = bankName;
        if (iban !== undefined) dbPayload.iban = iban;
        if (priceEmployee !== undefined) dbPayload.price_employee = priceEmployee || null;
        if (priceExternal !== undefined) dbPayload.price_external = priceExternal || null;
        if (supportPhone !== undefined) dbPayload.support_phone = supportPhone;
        if (isActive !== undefined) dbPayload.is_active = isActive !== false;
        if (notificationEmails !== undefined) dbPayload.notification_emails = notificationEmails || null;
        if (summaryEmails !== undefined) dbPayload.summary_emails = summaryEmails || null;
        if (requiresManagementApproval !== undefined) dbPayload.requires_management_approval = requiresManagementApproval === true;
        if (applyEmployeePriceToCorporate !== undefined) dbPayload.apply_employee_price_to_corporate = applyEmployeePriceToCorporate === true;
        if (allowIndividual !== undefined) dbPayload.allow_individual = allowIndividual !== false;
        if (tariffs !== undefined) dbPayload.tariffs = tariffs || [];
        if (templates !== undefined) dbPayload.templates = templates;
      } else {
        // CREATE: Enforce default values
        dbPayload = {
          name,
          category,
          company_title: companyTitle,
          tax_office: taxOffice,
          tax_number: taxNumber,
          bank_name: bankName,
          iban,
          price_employee: priceEmployee || null,
          price_external: priceExternal || null,
          support_phone: supportPhone,
          is_active: isActive !== false,
          notification_emails: notificationEmails || null,
          summary_emails: summaryEmails || null,
          requires_management_approval: requiresManagementApproval === true,
          apply_employee_price_to_corporate: applyEmployeePriceToCorporate === true,
          allow_individual: allowIndividual !== false,
          tariffs: tariffs || [],
          templates: templates || {}
        };
      }

      if (id) {
        // Get the old otopark record first to compare changes and check name cascade
        let oldOtopark = null;
        let oldName = null;
        try {
          const oldRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${id}&select=*`, {
            headers: {
              "apikey": supabaseAnonKey,
              "Authorization": `Bearer ${supabaseAnonKey}`
            }
          });
          if (oldRes.ok) {
            const oldData = await oldRes.json();
            if (oldData.length > 0) {
              oldOtopark = oldData[0];
              oldName = oldOtopark.name;
            }
          }
        } catch (err) {
          console.error("Error retrieving old otopark record:", err);
        }

        // UPDATE otopark
        const updateRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${id}`, {
          method: "PATCH",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify(dbPayload)
        });

        if (!updateRes.ok) {
          const errText = await updateRes.text();
          return new Response(JSON.stringify({ error: `Supabase update error: ${errText}` }), { status: updateRes.status, headers });
        }

        const data = await updateRes.json();

        // Cascade updates to applications and admin_users if name changed
        if (name !== undefined && oldName && oldName !== name) {
          try {
            // 1. Update applications.parking_location references
            await fetch(`${supabaseUrl}/rest/v1/applications?parking_location=eq.${encodeURIComponent(oldName)}`, {
              method: "PATCH",
              headers: {
                "apikey": supabaseAnonKey,
                "Authorization": `Bearer ${supabaseAnonKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ parking_location: name })
            });

            // 2. Update admin_users.otoparks arrays references
            const adminsRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?select=*`, {
              headers: {
                "apikey": supabaseAnonKey,
                "Authorization": `Bearer ${supabaseAnonKey}`
              }
            });
            if (adminsRes.ok) {
              const admins = await adminsRes.json();
              for (const admin of admins) {
                if (admin.otoparks && admin.otoparks.includes(oldName)) {
                  const updatedOtoparks = admin.otoparks.map(o => o === oldName ? name : o);
                  await fetch(`${supabaseUrl}/rest/v1/admin_users?id=eq.${admin.id}`, {
                    method: "PATCH",
                    headers: {
                      "apikey": supabaseAnonKey,
                      "Authorization": `Bearer ${supabaseAnonKey}`,
                      "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ otoparks: updatedOtoparks })
                  });
                }
              }
            }
          } catch (cascadeErr) {
            console.error("Error executing cascade updates for otopark name change:", cascadeErr);
          }
        }

        // Build detailed changes description
        const changes = [];
        if (oldOtopark) {
          const fieldLabels = {
            name: "Otopark Adı",
            category: "Otopark Kategorisi",
            company_title: "Firma Ünvanı",
            tax_office: "Vergi Dairesi",
            tax_number: "Vergi Numarası",
            bank_name: "Banka Adı",
            iban: "IBAN",
            price_employee: "Çalışan Tarifesi (Aylık)",
            price_external: "Dış Giriş Tarifesi (Aylık)",
            support_phone: "Destek Telefonu",
            is_active: "Aktiflik Durumu",
            notification_emails: "Anlık Bildirim E-postaları",
            summary_emails: "Günlük Özet E-postaları",
            requires_management_approval: "Sanayi/OSB Ön Onayı Gerekli",
            apply_employee_price_to_corporate: "B2B Firma Araçlarına Çalışan Fiyatı Uygula",
            allow_individual: "Bireysel Başvurulara İzin Ver"
          };

          for (const key in dbPayload) {
            if (fieldLabels[key] !== undefined) {
              const oldValue = oldOtopark[key];
              const newValue = dbPayload[key];

              const normOld = (oldValue === null || oldValue === undefined) ? "" : String(oldValue).trim();
              const normNew = (newValue === null || newValue === undefined) ? "" : String(newValue).trim();

              if (normOld !== normNew) {
                let oldDisp = oldValue;
                let newDisp = newValue;

                if (key === "is_active") {
                  oldDisp = oldValue ? "Aktif" : "Pasif";
                  newDisp = newValue ? "Aktif" : "Pasif";
                } else if (typeof oldValue === "boolean" || typeof newValue === "boolean") {
                  oldDisp = oldValue ? "Evet (Gerekli/Aktif)" : "Hayır (Pasif)";
                  newDisp = newValue ? "Evet (Gerekli/Aktif)" : "Hayır (Pasif)";
                }

                const displayOld = (oldDisp === "" || oldDisp === null || oldDisp === undefined) ? "Boş" : oldDisp;
                const displayNew = (newDisp === "" || newDisp === null || newDisp === undefined) ? "Boş" : newDisp;

                changes.push(`• ${fieldLabels[key]}: "${displayOld}" ➡️ "${displayNew}"`);
              }
            }
          }

          if (dbPayload.tariffs !== undefined) {
            const oldTariffs = JSON.stringify(oldOtopark.tariffs || []);
            const newTariffs = JSON.stringify(dbPayload.tariffs || []);
            if (oldTariffs !== newTariffs) {
              changes.push(`• Tarifeler & Ücretler: Tarifeler güncellendi.`);
            }
          }

          if (dbPayload.templates !== undefined) {
            const oldTemplates = JSON.stringify(oldOtopark.templates || {});
            const newTemplates = JSON.stringify(dbPayload.templates || {});
            if (oldTemplates !== newTemplates) {
              changes.push(`• Bildirim Şablonları: SMS/E-posta şablonları düzenlendi.`);
            }
          }
        }

        const currentName = (name !== undefined ? name : oldName) || "";
        const detailsText = changes.length > 0 
          ? `"${currentName}" otopark işletmesi bilgileri güncellendi:\n${changes.join("\n")}`
          : `"${currentName}" otopark işletmesi bilgileri güncellendi (değişiklik tespit edilmedi).`;

        // Log audit action
        const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
        const country = context.request.headers.get("CF-IPCountry") || "";
        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: "update_otopark",
            targetId: id,
            details: detailsText,
            ipAddress,
            country,
            otoparkName: currentName || null
          })
        );

        // Send Telegram alert for otopark update
        context.waitUntil(
          sendTelegramAlert(
            `<b>⚙️ Otopark Ayarları Güncellendi</b>\n\n` +
            `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
            `<b>Otopark:</b> ${currentName}\n` +
            `<b>IP Adresi:</b> ${ipAddress} (${country || 'Bilinmiyor'})\n` +
            `<b>Detaylar:</b>\n${changes.join("\n") || 'Değişiklik yapılmadı'}`,
            context.env
          )
        );

        return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
      } else {
        // CREATE otopark
        // Generate unique ID slug from Turkish name input
        const generatedId = name.toLocaleLowerCase("tr-TR")
          .replace(/[^a-z0-9ıışğüöç\s]/g, "")
          .replace(/\s+/g, "-");

        // Check if exists
        const checkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${generatedId}&select=id,is_deleted`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (checkRes.ok) {
          const matched = await checkRes.json();
          if (matched.length > 0) {
            const existingPark = matched[0];
            if (existingPark.is_deleted) {
              // Reactivate existing deleted otopark
              const reactivatePayload = {
                ...dbPayload,
                is_deleted: false,
                is_active: isActive !== false
              };

              const reactivateRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${generatedId}`, {
                method: "PATCH",
                headers: {
                  "apikey": supabaseAnonKey,
                  "Authorization": `Bearer ${supabaseAnonKey}`,
                  "Content-Type": "application/json",
                  "Prefer": "return=representation"
                },
                body: JSON.stringify(reactivatePayload)
              });

              if (!reactivateRes.ok) {
                const errText = await reactivateRes.text();
                return new Response(JSON.stringify({ error: `Supabase reactivate error: ${errText}` }), { status: reactivateRes.status, headers });
              }

              const data = await reactivateRes.json();

              // Log audit action
              const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
              const country = context.request.headers.get("CF-IPCountry") || "";
              context.waitUntil(
                logAudit({
                  supabaseUrl,
                  supabaseAnonKey,
                  username: user.username,
                  role: user.role,
                  actionType: "create_otopark",
                  targetId: generatedId,
                  details: `"${name}" adındaki arşivlenmiş otopark işletmesi tekrar etkinleştirildi.`,
                  ipAddress,
                  country,
                  otoparkName: name || null
                })
              );

              // Send Telegram alert for otopark reactivation
              context.waitUntil(
                sendTelegramAlert(
                  `<b>♻️ Otopark Tekrar Etkinleştirildi</b>\n\n` +
                  `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
                  `<b>Otopark:</b> ${name}\n` +
                  `<b>IP Adresi:</b> ${ipAddress} (${country || 'Bilinmiyor'})`,
                  context.env
                )
              );

              return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
            } else {
              return new Response(JSON.stringify({ error: "Bu isimde bir otopark zaten kayıtlı!" }), { status: 400, headers });
            }
          }
        }

        const createPayload = {
          id: generatedId,
          ...dbPayload
        };

        const createRes = await fetch(`${supabaseUrl}/rest/v1/otoparks`, {
          method: "POST",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify(createPayload)
        });

        if (!createRes.ok) {
          const errText = await createRes.text();
          return new Response(JSON.stringify({ error: `Supabase create error: ${errText}` }), { status: createRes.status, headers });
        }

        const data = await createRes.json();

        // Log audit action
        const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
        const country = context.request.headers.get("CF-IPCountry") || "";
        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: "create_otopark",
            targetId: generatedId,
            details: `"${name}" adında yeni otopark işletmesi oluşturuldu.`,
            ipAddress,
            country,
            otoparkName: name || null
          })
        );

        // Send Telegram alert for otopark creation
        context.waitUntil(
          sendTelegramAlert(
            `<b>🏢 Yeni Otopark Oluşturuldu</b>\n\n` +
            `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
            `<b>Yeni Otopark:</b> ${name} (${generatedId})\n` +
            `<b>IP Adresi:</b> ${ipAddress} (${country || 'Bilinmiyor'})`,
            context.env
          )
        );

        return new Response(JSON.stringify({ success: true, data }), { status: 201, headers });
      }
    }

    // ----------------------------------------------------
    // DELETE: Delete an otopark (Soft Delete / Archive)
    // ----------------------------------------------------
    if (method === "DELETE") {
      const { searchParams } = new URL(context.request.url);
      const id = searchParams.get("id");

      if (!id) {
        return new Response(JSON.stringify({ error: "Missing otopark id" }), { status: 400, headers });
      }

      const deleteRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({ is_deleted: true, is_active: false })
      });

      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        return new Response(JSON.stringify({ error: `Supabase archive error: ${errText}` }), { status: deleteRes.status, headers });
      }

      const deletedData = await deleteRes.json();
      const deletedOtopark = deletedData[0] || {};
      const otoparkName = deletedOtopark.name || id;

      // Log audit action
      const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
      const country = context.request.headers.get("CF-IPCountry") || "";
      context.waitUntil(
        logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "delete_otopark",
          targetId: id,
          details: `"${otoparkName}" otopark işletmesi arşivlendi (silindi).`,
          ipAddress,
          country,
          otoparkName: otoparkName || null
        })
      );

      // Send Telegram alert for otopark archiving
      context.waitUntil(
        sendTelegramAlert(
          `<b>❌ Otopark Arşivlendi (Silindi)</b>\n\n` +
          `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
          `<b>Arşivlenen Otopark:</b> ${otoparkName} (${id})\n` +
          `<b>IP Adresi:</b> ${ipAddress} (${country || 'Bilinmiyor'})`,
          context.env
        )
      );

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
