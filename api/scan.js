export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { mediaType, b64, isPdf } = req.body;

  if (!b64 || !mediaType) {
    return res.status(400).json({ error: "Missing b64 or mediaType" });
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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              isPdf
                ? { type: "document", source: { type: "base64", media_type: mediaType, data: b64 } }
                : { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              {
                type: "text",
                text: 'Extrae los datos de esta factura y responde SOLO con JSON sin texto adicional ni backticks: {"ref":"numero de factura","fecha":"DD/MM/YYYY","descripcion":"nombre del cliente o proveedor","base":"base imponible como numero sin simbolo euro","iva":"porcentaje IVA con % ej 21%","total":"importe total como numero sin simbolo euro"}',
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
