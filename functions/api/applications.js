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
        return null; // Expired
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
    "Access-Control-Allow-Methods": "GET, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";
  const bucket = context.env.BUCKET;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  // Authenticate Request
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Yetkisiz oturum! Lütfen giriş yapın." }), { status: 401, headers });
  }

  const token = authHeader.substring(7);
  const user = await verifyToken(token, jwtSecret);
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
      const { id, status } = await context.request.json();
      if (!id || !status) {
        return new Response(JSON.stringify({ error: "Missing id or status" }), { status: 400, headers });
      }

      // Check access: Fetch application first
      const getRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${id}&select=parking_location`, {
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

      const appLocation = apps[0].parking_location;

      // Access verification
      if (user.role !== "superadmin" && !user.otoparks.includes(appLocation)) {
        return new Response(JSON.stringify({ error: "Bu otoparkın verisini güncelleme yetkiniz yok!" }), { status: 403, headers });
      }

      // Update status
      const updateRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({ status })
      });

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        return new Response(JSON.stringify({ error: `Supabase update error: ${errText}` }), { status: updateRes.status, headers });
      }

      const updatedData = await updateRes.json();
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
      const deleteRes = await fetch(`${supabaseUrl}/rest/v1/applications?id=eq.${id}`, {
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

      // Delete documents from Cloudflare R2
      if (bucket) {
        try {
          const listed = await bucket.list({ prefix: `applications/${id}/` });
          if (listed && listed.objects) {
            for (const obj of listed.objects) {
              await bucket.delete(obj.key);
            }
          }
        } catch (r2Err) {
          console.error("R2 Delete Error:", r2Err);
          // Don't fail the whole request, database is already deleted
        }
      }

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
