import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIXELSTER_API = "https://ahm7xmakki.com/api/ptv";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3.5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Formato de imagen no válido. Usa JPG, PNG o WEBP."));
    }
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json({ limit: "6mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  console.log("HTTP_IN", JSON.stringify({
    method: req.method,
    path: req.path,
    contentLength: req.headers["content-length"] || null,
    contentType: req.headers["content-type"] || null
  }));
  res.on("finish", () => console.log("HTTP_OUT", JSON.stringify({
    method: req.method, path: req.path, status: res.statusCode,
    durationMs: Date.now() - started
  })));
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    videoEngineConfigured: true,
    engine: "PixelSter · FreeAPI",
    note: "Motor gratuito sin token; sujeto a límites de uso razonable."
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/generate", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Selecciona una fotografía primero." });
  }

  const promptText = String(req.body.prompt || "").trim();
  const style = String(req.body.style || "Libre").trim();
  const duration = Math.min(20, Math.max(5, Number.parseInt(req.body.duration || "10", 10) || 10));
  const movement = promptText || "La persona de la fotografía cobra vida y baila con movimientos naturales y fluidos";
  const prompt = `${movement}. Estilo musical: ${style}. Mantener la apariencia, rostro y ropa de la persona. Cámara estable, movimiento natural, buena iluminación.`;

  try {
    const imageBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    console.log("PIXELSTER_JOB_SUBMIT", JSON.stringify({
      duration, imageBytes: req.file.size, imageType: req.file.mimetype
    }));

    const requestBody = JSON.stringify({ prompt, ratio: "9:16", duration, imageBase64 });
    const requestOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: requestBody,
      signal: AbortSignal.timeout(180000),
      redirect: "manual"
    };

    let apiResponse = await fetch(PIXELSTER_API, requestOptions);
    console.log("PIXELSTER_HTTP_RESPONSE", JSON.stringify({
      status: apiResponse.status,
      url: apiResponse.url,
      redirected: apiResponse.redirected,
      location: apiResponse.headers.get("location"),
      allow: apiResponse.headers.get("allow")
    }));

    // Preserve POST and its JSON body when the provider redirects the API route.
    if ([301, 302, 303, 307, 308].includes(apiResponse.status)) {
      const redirectTo = apiResponse.headers.get("location");
      if (!redirectTo) throw new Error(`PixelSter redirigió con HTTP ${apiResponse.status} pero no indicó destino.`);
      const redirectUrl = new URL(redirectTo, PIXELSTER_API).toString();
      apiResponse = await fetch(redirectUrl, requestOptions);
      console.log("PIXELSTER_REDIRECT_RESPONSE", JSON.stringify({
        status: apiResponse.status,
        url: redirectUrl,
        location: apiResponse.headers.get("location"),
        allow: apiResponse.headers.get("allow")
      }));
    }

    const raw = await apiResponse.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = null; }

    if (!apiResponse.ok) {
      const detail = result?.error || result?.message || raw.slice(0, 240) || "Sin detalles del proveedor.";
      throw new Error(`PixelSter respondió HTTP ${apiResponse.status}: ${detail}`);
    }
    if (!result?.success || !result?.videoUrl || !/^https:\/\//i.test(result.videoUrl)) {
      throw new Error(result?.error || result?.message || "PixelSter no devolvió un enlace válido al video.");
    }

    console.log("PIXELSTER_JOB_SUCCESS", JSON.stringify({ hasVideoUrl: true }));
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(`event: complete\ndata: ${JSON.stringify([{ url: result.videoUrl }])}\n\n`);
    res.end();
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("PixelSter image-to-video error:", detail);
    if (!res.headersSent) {
      const limited = /429|rate.?limit|throttl|busy|ocupado/i.test(detail);
      return res.status(limited ? 503 : 502).json({
        error: limited
          ? "PixelSter alcanzó temporalmente su límite gratuito. Espera un poco y vuelve a intentarlo."
          : "No se pudo generar el video con PixelSter: " + detail.slice(0, 260)
      });
    }
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error("REQUEST_ERROR", String(err?.message || err));
  res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error: err?.code === "LIMIT_FILE_SIZE"
      ? "La fotografía supera el máximo de 3.5 MB que acepta PixelSter."
      : err.message || "No se pudo procesar la solicitud."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`DJ SEBAS AI VIDEO activo en puerto ${port}`));
