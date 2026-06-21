// Helper for safe base64 decoding (supports Unicode)
import { logAudit } from "./audit_helper.js";
import { sendTelegramAlert } from "./telegram_helper.js";

function validatePassword(password) {
  if (!password || password.length < 8) return false;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return hasUppercase && hasLowercase && hasDigit && hasSpecial;
}

async function hashPassword(password, salt = "parkexpert-salt-key-98765") {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Helper to upload base64 avatar to R2
async function uploadAvatarToR2(adminId, photoBase64, bucket) {
  if (!photoBase64 || !bucket) return;
  try {
    const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, "");
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    await bucket.put(`avatars/${adminId}.jpg`, bytes, {
      httpMetadata: { contentType: "image/jpeg" }
    });
  } catch (e) {
    console.error(`Failed to upload avatar for admin ${adminId}:`, e);
  }
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
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  // Authenticate Request (Super Admin Only)
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const clientIp = context.request.headers.get("CF-Connecting-IP") || "";
  const user = await verifyToken(token, jwtSecret, clientIp, supabaseUrl, supabaseAnonKey);
  if (!user || user.role !== "superadmin") {
    return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
  }

  const method = context.request.method;

  try {
    // ----------------------------------------------------
    // GET: List all admin users
    // ----------------------------------------------------
    if (method === "GET") {
      const res = await fetch(`${supabaseUrl}/rest/v1/admin_users?select=*&order=created_at.desc`, {
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
    // POST: Create or Update an admin user
    // ----------------------------------------------------
    if (method === "POST") {
      const payload = await context.request.json();
      const { id, name, username, password, otoparks, phone, email, photo_base64, is_self_avatar } = payload;

      // Handle self avatar upload
      if (is_self_avatar) {
        if (!id || !photo_base64) {
          return new Response(JSON.stringify({ error: "Eksik bilgi! ID veya fotoğraf verisi bulunamadı." }), { status: 400, headers });
        }
        // Authorize: Must be superadmin editing superadmin avatar
        if (id !== "superadmin") {
          return new Response(JSON.stringify({ error: "Bu işlem için yetkiniz bulunmamaktadır!" }), { status: 403, headers });
        }
        await uploadAvatarToR2(id, photo_base64, context.env.BUCKET);
        return new Response(JSON.stringify({ success: true, message: "Profil fotoğrafı başarıyla güncellendi." }), { status: 200, headers });
      }

      // Normal admin creation/update requires superadmin role
      if (user.role !== "superadmin") {
        return new Response(JSON.stringify({ error: "Bu işlem için Süper Yönetici yetkiniz bulunmalıdır." }), { status: 403, headers });
      }

      if (!name || !username || !otoparks || otoparks.length === 0) {
        return new Response(JSON.stringify({ error: "Ad Soyad, kullanıcı adı ve otopark bilgisi zorunludur." }), { status: 400, headers });
      }

      if (id) {
        // Fetch old admin profile first to compare changes
        let oldAdmin = {};
        try {
          const oldRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?id=eq.${id}&select=*`, {
            headers: {
              "apikey": supabaseAnonKey,
              "Authorization": `Bearer ${supabaseAnonKey}`
            }
          });
          if (oldRes.ok) {
            const oldRows = await oldRes.json();
            if (oldRows.length > 0) {
              oldAdmin = oldRows[0];
            }
          }
        } catch (e) {
          console.warn("Failed to fetch old admin for auditing:", e);
        }

        // If username is provided, check if it's taken by another user
        if (username) {
          const checkRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&id=neq.${id}&select=id`, {
            headers: {
              "apikey": supabaseAnonKey,
              "Authorization": `Bearer ${supabaseAnonKey}`
            }
          });

          if (checkRes.ok) {
            const matched = await checkRes.json();
            if (matched.length > 0 || username.toLowerCase() === "superadmin") {
              return new Response(JSON.stringify({ error: "Bu kullanıcı adı sistemde zaten kayıtlı!" }), { status: 400, headers });
            }
          }
        }

        // UPDATE existing admin
        const updatePayload = {
          name,
          username: username.toLowerCase(),
          otoparks,
          phone: phone || null,
          email: email || null
        };
        // Only update password if provided
        if (password) {
          if (!validatePassword(password)) {
            return new Response(JSON.stringify({ 
              error: "Şifre en az 8 karakter uzunluğunda olmalı, en az bir büyük harf, bir küçük harf, bir rakam ve bir özel karakter içermelidir." 
            }), { status: 400, headers });
          }
          updatePayload.password = await hashPassword(password, context.env.PASSWORD_SALT || "parkexpert-salt-key-98765");
        }

        const updateRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?id=eq.${id}`, {
          method: "PATCH",
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify(updatePayload)
        });

        if (!updateRes.ok) {
          const errText = await updateRes.text();
          return new Response(JSON.stringify({ error: `Supabase update error: ${errText}` }), { status: updateRes.status, headers });
        }

        const data = await updateRes.json();

        // Log audit action
        const changes = [];
        if (oldAdmin.name !== name) {
          changes.push(`Ad Soyad: "${oldAdmin.name || ''}" ➔ "${name}"`);
        }
        if (oldAdmin.username !== username.toLowerCase()) {
          changes.push(`Kullanıcı Adı: "${oldAdmin.username || ''}" ➔ "${username.toLowerCase()}"`);
        }
        if (password) {
          changes.push(`Şifre güncellendi`);
        }
        const oldOtoparks = (oldAdmin.otoparks || []).join(", ");
        const newOtoparks = (otoparks || []).join(", ");
        if (oldOtoparks !== newOtoparks) {
          changes.push(`Yetkili Otoparklar: [${oldOtoparks}] ➔ [${newOtoparks}]`);
        }
        if (oldAdmin.phone !== phone) {
          changes.push(`Telefon: "${oldAdmin.phone || ''}" ➔ "${phone || ''}"`);
        }
        if (oldAdmin.email !== email) {
          changes.push(`E-posta: "${oldAdmin.email || ''}" ➔ "${email || ''}"`);
        }

        let details = `"${name}" (${username}) yöneticisinin bilgileri güncellendi.`;
        if (changes.length > 0) {
          details += " (Değişenler: " + changes.join(", ") + ")";
        }

        const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: "update_admin",
            targetId: id,
            details,
            ipAddress
          })
        );

        context.waitUntil(
          sendTelegramAlert(
            `<b>✏️ Yönetici Güncellendi</b>\n\n` +
            `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
            `<b>IP Adresi:</b> ${ipAddress}\n` +
            `<b>Detay:</b> ${details}`,
            context.env
          )
        );

        if (photo_base64) {
          await uploadAvatarToR2(id, photo_base64, context.env.BUCKET);
        }

        return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
      } else {
        // CREATE new admin
        if (!password) {
          return new Response(JSON.stringify({ error: "Yeni yöneticiler için şifre zorunludur." }), { status: 400, headers });
        }
        if (!validatePassword(password)) {
          return new Response(JSON.stringify({ 
            error: "Şifre en az 8 karakter uzunluğunda olmalı, en az bir büyük harf, bir küçük harf, bir rakam ve bir özel karakter içermelidir." 
          }), { status: 400, headers });
        }

        // Check if username already exists
        const checkRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&select=id`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (checkRes.ok) {
          const matched = await checkRes.json();
          if (matched.length > 0 || username.toLowerCase() === "superadmin") {
            return new Response(JSON.stringify({ error: "Bu kullanıcı adı sistemde zaten kayıtlı!" }), { status: 400, headers });
          }
        }

        const newAdminId = "admin-" + Date.now();
        const createPayload = {
          id: newAdminId,
          name,
          username: username.toLowerCase(),
          password: await hashPassword(password, context.env.PASSWORD_SALT || "parkexpert-salt-key-98765"),
          otoparks,
          phone: phone || null,
          email: email || null
        };

        const createRes = await fetch(`${supabaseUrl}/rest/v1/admin_users`, {
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
        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: "create_admin",
            targetId: newAdminId,
            details: `"${name}" (${username}) yetkili yöneticisi oluşturuldu.`,
            ipAddress
          })
        );

        context.waitUntil(
          sendTelegramAlert(
            `<b>👤 Yeni Yönetici Oluşturuldu</b>\n\n` +
            `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
            `<b>IP Adresi:</b> ${ipAddress}\n` +
            `<b>Yeni Yönetici:</b> ${name} (${username.toLowerCase()}, Yetki: [${otoparks.join(", ")}])`,
            context.env
          )
        );

        if (photo_base64) {
          await uploadAvatarToR2(newAdminId, photo_base64, context.env.BUCKET);
        }

        return new Response(JSON.stringify({ success: true, data }), { status: 201, headers });
      }
    }

    // ----------------------------------------------------
    // DELETE: Delete an admin user
    // ----------------------------------------------------
    if (method === "DELETE") {
      const { searchParams } = new URL(context.request.url);
      const id = searchParams.get("id");

      if (!id) {
        return new Response(JSON.stringify({ error: "Missing admin id" }), { status: 400, headers });
      }

      const deleteRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?id=eq.${id}`, {
        method: "DELETE",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Prefer": "return=representation"
        }
      });

      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        return new Response(JSON.stringify({ error: `Supabase delete error: ${errText}` }), { status: deleteRes.status, headers });
      }

      const deletedData = await deleteRes.json();
      const deletedAdmin = deletedData[0] || {};
      const adminName = deletedAdmin.name || id;
      const adminUsername = deletedAdmin.username || "";

      // Log audit action
      const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
      context.waitUntil(
        logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "delete_admin",
          targetId: id,
          details: `"${adminName}" (${adminUsername}) yetkili yöneticisi silindi.`,
          ipAddress
        })
      );

      context.waitUntil(
        sendTelegramAlert(
          `<b>❌ Yönetici Silindi</b>\n\n` +
          `<b>Yapan:</b> ${user.username} (Rol: ${user.role})\n` +
          `<b>IP Adresi:</b> ${ipAddress}\n` +
          `<b>Silinen Yönetici:</b> ${adminName} (${adminUsername})`,
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
