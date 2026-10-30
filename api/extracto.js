export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { b64 } = req.body;

  if (!b64) {
    return res.status(400).json({ error: "Missing b64" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
              {
                type: "text",
                text: 'Esto es un extracto bancario. Extrae TODOS los movimientos, en orden, y responde SOLO con JSON sin texto adicional ni backticks: {"movimientos":[{"fecha":"DD/MM/YYYY (fecha de operación)","concepto":"concepto completo del movimiento","importe":numero con signo (negativo si es cargo/salida, positivo si es abono/entrada),"saldo":numero o null}]}. Usa punto como separador decimal. No incluyas saldos iniciales/finales ni totales como movimientos.',
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || "Error de la API" });
    const text = data.content?.find(c => c.type === "text")?.text || "{}";
    const json = JSON.parse(text.replace(/```json|```/g, "").trim());
    return res.status(200).json(json);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
