import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "expert-quotes-requests-service" });
});

export default router;
