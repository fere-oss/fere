import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const DAILY_LIMIT = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. Validate the Supabase access token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Use Supabase user UUID (provider-agnostic)
    const userId = user.id;
    const today = new Date().toISOString().slice(0, 10);

    // 3. Check usage
    const { data: usageRow } = await supabase
      .from("usage")
      .select("count")
      .eq("user_id", userId)
      .eq("date", today)
      .single();

    const currentCount = usageRow?.count ?? 0;

    if (currentCount >= DAILY_LIMIT) {
      return new Response(
        JSON.stringify({ error: "limit_reached", used: DAILY_LIMIT, limit: DAILY_LIMIT }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 4. Increment usage
    await supabase.from("usage").upsert(
      { user_id: userId, date: today, count: currentCount + 1 },
      { onConflict: "user_id,date" },
    );

    // 5. Parse request body
    const { messages, context } = await req.json();
    if (!Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "invalid_payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6. Build OpenAI messages — prepend system context
    const openaiMessages = [
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...messages,
    ];

    // 7. Call OpenAI with streaming
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: openaiMessages,
        max_tokens: 4096,
        temperature: 0.3,
        stream: true,
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      return new Response(
        JSON.stringify({ error: "openai_error", detail: errBody }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 8. Stream SSE response back to client
    const remaining = DAILY_LIMIT - (currentCount + 1);
    return new Response(openaiRes.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Remaining": String(remaining),
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "internal", detail: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
