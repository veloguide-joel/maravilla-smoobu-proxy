export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const response = await fetch(
      `${process.env.SMOOBU_API_BASE}/apartments`,
      {
        headers: {
          "Api-Key": process.env.SMOOBU_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(200).json({
      ok: true,
      count: Array.isArray(data) ? data.length : null,
      data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
