import { applyCors, handleCorsPreflight } from "../_cors";

export default function handler(req, res) {
  if (handleCorsPreflight(req, res)) {
    return;
  }

  applyCors(req, res);
  res.status(200).json({ ok: true, route: "holds/ping" });
}
