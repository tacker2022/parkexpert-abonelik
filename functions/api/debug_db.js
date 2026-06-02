export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), { status: 500, headers });
  }

  try {
    // 1. Query applications
    const appRes = await fetch(`${supabaseUrl}/rest/v1/applications?select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const apps = appRes.ok ? await appRes.json() : { error: await appRes.text(), status: appRes.status };

    // 2. Query otoparks
    const otoparkRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const otoparks = otoparkRes.ok ? await otoparkRes.json() : { error: await otoparkRes.text(), status: otoparkRes.status };

    // 3. Query admin_users
    const adminRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const admins = adminRes.ok ? await adminRes.json() : { error: await adminRes.text(), status: adminRes.status };

    return new Response(JSON.stringify({
      supabaseUrl,
      applications: {
        count: Array.isArray(apps) ? apps.length : null,
        data: apps
      },
      otoparks: {
        count: Array.isArray(otoparks) ? otoparks.length : null,
        data: otoparks
      },
      admins: {
        count: Array.isArray(admins) ? admins.length : null,
        data: admins
      }
    }, null, 2), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
