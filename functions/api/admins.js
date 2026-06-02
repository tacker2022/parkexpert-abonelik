// Helper to verify JWT token using HMAC-SHA256
async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payloadStr = atob(parts[0]);
    const signatureHex = parts[1];

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
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
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;
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
  const user = await verifyToken(token, jwtSecret);
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
      const { id, name, username, password, otoparks } = payload;

      if (!name || !username || !otoparks || otoparks.length === 0) {
        return new Response(JSON.stringify({ error: "Ad Soyad, kullanıcı adı ve otopark bilgisi zorunludur." }), { status: 400, headers });
      }

      if (id) {
        // UPDATE existing admin
        const updatePayload = {
          name,
          otoparks
        };
        // Only update password if provided
        if (password) {
          updatePayload.password = password;
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
        return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
      } else {
        // CREATE new admin
        if (!password) {
          return new Response(JSON.stringify({ error: "Yeni yöneticiler için şifre zorunludur." }), { status: 400, headers });
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
          password,
          otoparks
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

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
