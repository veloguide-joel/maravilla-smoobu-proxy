import { pool } from "../_db";

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    route: "holds/active",
    query: req.query
  });
}
