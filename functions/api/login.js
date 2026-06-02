// Helper to sign token using HMAC-SHA256
async function signToken(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const payloadStr = JSON.stringify({ ...data, exp: Date.now() + 24 * 60 * 60 * 1000 }); // 24 Hours expiry
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadStr)
  );

  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const signatureHex = signatureArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return btoa(payloadStr) + "." + signatureHex;
}

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
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

  const supabaseUrl = context.env.SUPABASE_URL;
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;
  const jwtSecret = context.env.JWT_SECRET || "parkexpert-super-secret-key-12345";
  const rootPassword = context.env.SUPERADMIN_PASSWORD || "admin123";

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    const { username, password } = await context.request.json();

    if (!username || !password) {
      return new Response(JSON.stringify({ error: "Username and password are required" }), { status: 400, headers });
    }

    let userObj = null;

    if (username.toLowerCase() === "superadmin") {
      if (password === rootPassword) {
        userObj = {
          id: "superadmin",
          name: "Süper Yönetici",
          username: "superadmin",
          role: "superadmin",
          otoparks: []
        };
      }
    } else {
      // Query admin user in Supabase
      const res = await fetch(`${supabaseUrl}/rest/v1/admin_users?username=eq.${username.toLowerCase()}&password=eq.${password}&select=*`, {
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${supabaseAnonKey}`
        }
      });

      if (res.ok) {
        const admins = await res.json();
        if (admins.length > 0) {
          const admin = admins[0];
          userObj = {
            id: admin.id,
            name: admin.name,
            username: admin.username,
            role: "admin",
            otoparks: admin.otoparks || []
          };
        }
      }
    }

    if (!userObj) {
      return new Response(JSON.stringify({ error: "Hatalı kullanıcı adı veya şifre!" }), { status: 401, headers });
    }

    // Sign session token
    const token = await signToken(userObj, jwtSecret);

    return new Response(JSON.stringify({ success: true, user: userObj, token }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
