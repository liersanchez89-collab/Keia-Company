export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: "Missing path" });

  const CLOCKIFY_KEY = process.env.CLOCKIFY_KEY; // variable de entorno en Vercel (opcional)

  try {
    const isPost = req.method === "POST";
    const isPut  = req.method === "PUT";
    const isReports = path.includes("reports");
    const url = isReports
      ? `https://reports.api.clockify.me/v1/${path}`
      : `https://api.clockify.me/api/v1/${path}`;

    const fetchOpts = {
      method: isPost ? "POST" : isPut ? "PUT" : "GET",
      headers: {
        "X-Api-Key": CLOCKIFY_KEY,
        "Content-Type": "application/json",
      },
    };

    if ((isPost || isPut) && req.body) {
      fetchOpts.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOpts);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
