export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const supabaseUrl = context.env.SUPABASE_URL?.replace(/\/+$/, "")?.replace(/\/rest\/v1$/, "");
  const supabaseAnonKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase configuration", envKeys: Object.keys(context.env) }), { status: 500, headers });
  }

  try {
    // Fetch otoparks
    const otoparksRes = await fetch(`${supabaseUrl}/rest/v1/otoparks?select=*`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const otoparks = otoparksRes.ok ? await otoparksRes.json() : { error: await otoparksRes.text() };

    // Fetch last 5 applications
    const appsRes = await fetch(`${supabaseUrl}/rest/v1/applications?select=*&order=created_at.desc&limit=5`, {
      headers: {
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`
      }
    });
    const applications = appsRes.ok ? await appsRes.json() : { error: await appsRes.text() };

    return new Response(JSON.stringify({
      success: true,
      otoparks,
      applications
    }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers });
  }
}
