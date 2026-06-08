// Helper for safe base64 decoding (supports Unicode)
import { logAudit } from "./audit_helper.js";
function base64Decode(base64) {
  const binString = atob(base64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Helper to verify JWT token using HMAC-SHA256
async function verifyToken(token, secret) {
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
      return payload;
    }
  } catch (e) {
    return null;
  }
  return null;
}

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
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

  const method = context.request.method;

  try {
    // ----------------------------------------------------
    // GET: List all otoparks (Public)
    // ----------------------------------------------------
    if (method === "GET") {
      const res = await fetch(`${supabaseUrl}/rest/v1/otoparks?select=*&order=name.asc`, {
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

    // Authenticate for POST and DELETE (Super Admin Only)
    const authHeader = context.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Yetkisiz oturum!" }), { status: 401, headers });
    }

    const token = authHeader.substring(7);
    const user = await verifyToken(token, jwtSecret);
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
        templates
      } = payload;

      if (!name || !category || !companyTitle || !taxOffice || !taxNumber || !bankName || !iban || !priceEmployee || !priceExternal || !supportPhone) {
        return new Response(JSON.stringify({ error: "Lütfen zorunlu alanları doldurun." }), { status: 400, headers });
      }

      const dbPayload = {
        name,
        category,
        company_title: companyTitle,
        tax_office: taxOffice,
        tax_number: taxNumber,
        bank_name: bankName,
        iban,
        price_employee: priceEmployee,
        price_external: priceExternal,
        support_phone: supportPhone,
        is_active: isActive !== false
      };

      if (templates !== undefined) {
        dbPayload.templates = templates;
      }

      if (id) {
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

        // Log audit action
        const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: "update_otopark",
            targetId: id,
            details: `"${name}" otopark işletmesi bilgileri güncellendi.`,
            ipAddress
          })
        );

        return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
      } else {
        // CREATE otopark
        // Generate unique ID slug from Turkish name input
        const generatedId = name.toLocaleLowerCase("tr-TR")
          .replace(/[^a-z0-9ıışğüöç\s]/g, "")
          .replace(/\s+/g, "-");

        // Check if exists
        const checkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${generatedId}&select=id`, {
          headers: {
            "apikey": supabaseAnonKey,
            "Authorization": `Bearer ${supabaseAnonKey}`
          }
        });

        if (checkRes.ok) {
          const matched = await checkRes.json();
          if (matched.length > 0) {
            return new Response(JSON.stringify({ error: "Bu isimde bir otopark zaten kayıtlı!" }), { status: 400, headers });
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
        context.waitUntil(
          logAudit({
            supabaseUrl,
            supabaseAnonKey,
            username: user.username,
            role: user.role,
            actionType: "create_otopark",
            targetId: generatedId,
            details: `"${name}" adında yeni otopark işletmesi oluşturuldu.`,
            ipAddress
          })
        );

        return new Response(JSON.stringify({ success: true, data }), { status: 201, headers });
      }
    }

    // ----------------------------------------------------
    // DELETE: Delete an otopark
    // ----------------------------------------------------
    if (method === "DELETE") {
      const { searchParams } = new URL(context.request.url);
      const id = searchParams.get("id");

      if (!id) {
        return new Response(JSON.stringify({ error: "Missing otopark id" }), { status: 400, headers });
      }

      const deleteRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?id=eq.${id}`, {
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
      const deletedOtopark = deletedData[0] || {};
      const otoparkName = deletedOtopark.name || id;

      // Log audit action
      const ipAddress = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("x-real-ip") || "";
      context.waitUntil(
        logAudit({
          supabaseUrl,
          supabaseAnonKey,
          username: user.username,
          role: user.role,
          actionType: "delete_otopark",
          targetId: id,
          details: `"${otoparkName}" otopark işletmesi silindi.`,
          ipAddress
        })
      );

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
