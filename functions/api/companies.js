import { logAudit } from "./audit_helper.js";
import { sendSMS } from "./sms_helper.js";
import { sendWhatsApp } from "./whatsapp_helper.js";
import { sendEmail } from "./email_helper.js";

// Helper for safe base64 decoding (supports Unicode)
function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function hashPassword(password, salt = "parkexpert-salt-key-98765") {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
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
          return null; 
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
              return null; 
            }
          }
        } catch (e) {
          console.error("Blacklist check error:", e);
        }
      } else {
        return null; 
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

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  const method = context.request.method;

  try {
    // ----------------------------------------------------
    // GET: Fetch otopark companies (Publicly readable)
    // ----------------------------------------------------
    if (method === "GET") {
      const url = new URL(context.request.url);
      const otopark = url.searchParams.get("otopark");

      if (!otopark) {
        return new Response(JSON.stringify({ error: "otopark parametresi zorunludur." }), { status: 400, headers });
      }

      const res = await fetch(`${supabaseUrl}/rest/v1/companies?otopark_name=eq.${encodeURIComponent(otopark)}&select=*&order=name.asc`, {
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
    // AUTHENTICATED METHODS: POST & DELETE
    // ----------------------------------------------------
    if (!jwtSecret) {
      return new Response(JSON.stringify({ error: "Server security environment variable (JWT_SECRET) is not configured." }), { status: 500, headers });
    }

    const authHeader = context.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Yetkisiz oturum!" }), { status: 401, headers });
    }

    const token = authHeader.substring(7);
    const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
    const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);

    if (!user) {
      return new Response(JSON.stringify({ error: "Yetkisiz veya süresi geçmiş oturum!" }), { status: 401, headers });
    }

    const allowedRoles = ["superadmin", "admin", "operator", "yonetim", "yonetim_avm", "yonetim_site"];
    if (!allowedRoles.includes(user.role)) {
      return new Response(JSON.stringify({ error: "Bu işlem için yetkiniz bulunmamaktadır." }), { status: 403, headers });
    }

    // ----------------------------------------------------
    // POST: Create or bulk upload companies
    // ----------------------------------------------------
    if (method === "POST") {
      const payload = await context.request.json();
      const { otopark_name, companies } = payload;

      if (!otopark_name || !companies || !Array.isArray(companies) || companies.length === 0) {
        return new Response(JSON.stringify({ error: "Lütfen geçerli bir otopark ve firma listesi gönderin." }), { status: 400, headers });
      }

      // Check otopark authorization for non-superadmin users
      if (user.role !== "superadmin" && (!user.otoparks || !user.otoparks.includes(otopark_name))) {
        return new Response(JSON.stringify({ error: "Bu otopark için firma ekleme yetkiniz bulunmamaktadır." }), { status: 403, headers });
      }

      // Construct db payload (deduplicated & trimmed)
      const uniqueNames = [...new Set(companies.map(name => name.trim()))].filter(name => name.length > 0);
      const dbPayload = uniqueNames.map(name => ({
        name: name,
        otopark_name: otopark_name,
        created_by: user.username
      }));

      if (dbPayload.length === 0) {
        return new Response(JSON.stringify({ error: "Lütfen geçerli firma adları girin." }), { status: 400, headers });
      }

      // Insert/upsert into companies (ignore duplicates on conflict)
      const res = await fetch(`${supabaseUrl}/rest/v1/companies?on_conflict=otopark_name,name`, {
        method: "POST",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=ignore-duplicates,return=representation"
        },
        body: JSON.stringify(dbPayload)
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Supabase database error: ${errText}` }), { status: res.status, headers });
      }

      const resText = await res.text();
      let inserted = [];
      if (resText.trim()) {
        try {
          inserted = JSON.parse(resText);
        } catch (e) {
          console.error("Failed to parse inserted rows:", e);
        }
      }

      // Log action in audit logs
      try {
        await logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "Firma Toplu Yükleme",
          details: `Otopark: ${otopark_name}, Yüklenen Firma Sayısı: ${dbPayload.length}, Başarılı/Yeni Eklenen: ${Array.isArray(inserted) ? inserted.length : 0}`,
          ipAddress: clientIp,
          otoparkName: otopark_name || null
        });
      } catch (e) {
        console.error("Audit log error:", e);
      }

      const insertedCount = Array.isArray(inserted) ? inserted.length : 0;
      return new Response(JSON.stringify({ success: true, count: insertedCount }), { status: 200, headers });
    }

    // ----------------------------------------------------
    // PATCH: Update company credentials and quota
    // ----------------------------------------------------
    if (method === "PATCH") {
      const payload = await context.request.json();
      const { id, username, password, quota_limit, m2_area, rep_name, rep_phone, rep_email, send_sms } = payload;
      
      if (!id) {
        return new Response(JSON.stringify({ error: "Güncellenecek firma ID'si belirtilmelidir." }), { status: 400, headers });
      }

      // Fetch company details to verify otopark access
      const fetchRes = await fetch(`${supabaseUrl}/rest/v1/companies?id=eq.${id}&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!fetchRes.ok) {
        return new Response(JSON.stringify({ error: "Firma bulunamadı." }), { status: 404, headers });
      }

      const rows = await fetchRes.json();
      if (rows.length === 0) {
        return new Response(JSON.stringify({ error: "Firma bulunamadı." }), { status: 404, headers });
      }

      const company = rows[0];

      // Check access: only superadmin or admins of this otopark
      if (user.role !== "superadmin" && (!user.otoparks || !user.otoparks.includes(company.otopark_name))) {
        return new Response(JSON.stringify({ error: "Bu otoparktaki firmayı güncelleme yetkiniz bulunmamaktadır." }), { status: 403, headers });
      }

      const updatePayload = {};
      if (username !== undefined) updatePayload.username = username ? username.trim().toLowerCase() : null;
      if (quota_limit !== undefined) updatePayload.quota_limit = parseInt(quota_limit) || 0;
      if (m2_area !== undefined) updatePayload.m2_area = parseInt(m2_area) || 0;
      if (rep_name !== undefined) updatePayload.rep_name = rep_name ? rep_name.trim() : null;
      if (rep_phone !== undefined) updatePayload.rep_phone = rep_phone ? rep_phone.trim() : null;
      if (rep_email !== undefined) updatePayload.rep_email = rep_email ? rep_email.trim() : null;
      
      if (password) {
        const salt = context.env.PASSWORD_SALT;
        updatePayload.password = await hashPassword(password, salt);
      }

      const updateRes = await fetch(`${supabaseUrl}/rest/v1/companies?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(updatePayload)
      });

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        return new Response(JSON.stringify({ error: `Supabase update error: ${errText}` }), { status: updateRes.status, headers });
      }

      // Send SMS/WhatsApp/Email credentials notification if requested
      const targetPhone = rep_phone || company.rep_phone;
      if (send_sms && targetPhone) {
        const cleanPhone = targetPhone.replace(/\D/g, "");
        if (cleanPhone) {
          const targetName = rep_name || company.rep_name || "Firma Yetkilisi";
          const targetUser = username || company.username || "Tanımlanmadı";
          const passMsg = password ? password : "(Değiştirilmedi, mevcut şifreniz geçerlidir)";
          const messageText = `Merhaba ${targetName},\n\n${company.otopark_name} bünyesindeki "${company.name}" firması için Kurumsal Temsilci Paneli giriş bilgileriniz tanımlanmıştır.\n\n🌐 Giriş Adresi: https://parkexpertabonelik.net/admin\n👤 Kullanıcı Adı: ${targetUser}\n🔑 Şifre: ${passMsg}\n\nBu bilgilerle giriş yaparak şirket araçlarınızı ve personellerinizi kendiniz tanımlayabilirsiniz.`;

          // Send notifications in parallel to prevent client-side timeouts
          const notifications = [];
          
          notifications.push(
            sendSMS(cleanPhone, messageText, context.env)
              .catch(e => console.error("Credentials SMS send error:", e))
          );
          
          notifications.push(
            sendWhatsApp(cleanPhone, messageText, context.env)
              .catch(e => console.error("Credentials WhatsApp send error:", e))
          );
          
          const targetEmail = rep_email || company.rep_email;
          if (targetEmail) {
            notifications.push(
              sendEmail({
                to: targetEmail,
                subject: `Kurumsal Panel Giriş Bilgileri - ${company.name}`,
                html: messageText.replace(/\n/g, "<br>"),
                env: context.env
              })
                .catch(e => console.error("Credentials Email send error:", e))
            );
          }

          if (context.waitUntil) {
            context.waitUntil(Promise.all(notifications));
          } else {
            await Promise.all(notifications);
          }
        }
      }

      // Log action in audit logs
      try {
        await logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "Firma Güncelleme",
          details: `Firma: ${company.name} (${company.otopark_name}) yetki ve kota bilgileri güncellendi.`,
          ipAddress: clientIp,
          otoparkName: company.otopark_name || null,
          companyName: company.name || null
        });
      } catch (e) {
        console.error("Audit log error:", e);
      }

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    // ----------------------------------------------------
    // DELETE: Delete a company (Super Admin ONLY)
    // ----------------------------------------------------
    if (method === "DELETE") {
      if (user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Firmaları silme yetkisi sadece Süper Yöneticiye aittir." }), { status: 403, headers });
      }

      const url = new URL(context.request.url);
      const id = url.searchParams.get("id");

      if (!id) {
        return new Response(JSON.stringify({ error: "Silinecek firma ID'si belirtilmelidir." }), { status: 400, headers });
      }

      // Fetch company name for audit logs
      let companyName = "";
      let otoparkName = "";
      try {
        const fetchRes = await fetch(`${supabaseUrl}/rest/v1/companies?id=eq.${id}&select=name,otopark_name`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });
        if (fetchRes.ok) {
          const rows = await fetchRes.json();
          if (rows.length > 0) {
            companyName = rows[0].name;
            otoparkName = rows[0].otopark_name;
          }
        }
      } catch (e) {
        console.error("Error fetching company details before delete:", e);
      }

      const res = await fetch(`${supabaseUrl}/rest/v1/companies?id=eq.${id}`, {
        method: "DELETE",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Supabase delete error: ${errText}` }), { status: res.status, headers });
      }

      // Log action in audit logs
      try {
        await logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "Firma Silme",
          details: `Firma: ${companyName || id} (${otoparkName || ''}) sistemden silindi.`,
          ipAddress: clientIp,
          otoparkName: otoparkName || null,
          companyName: companyName || null
        });
      } catch (e) {
        console.error("Audit log error:", e);
      }

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  } catch (e) {
    return new Response(JSON.stringify({ error: `Server error: ${e.message}` }), { status: 500, headers });
  }
}
