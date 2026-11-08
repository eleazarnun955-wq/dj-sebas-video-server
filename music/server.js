import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.use(express.static(path.join(root, "public"), { extensions: ["html"] }));

app.get("/api/status", (_req, res) => {
  res.json({
    status: "online",
    app: "DJ SEBAS MIX STUDIO",
    mode: "local-browser-audio-mixer",
    aiRequired: false,
    externalApiRequired: false,
    localFilesStayOnDevice: true
  });
});

app.get("*", (_req, res) => res.sendFile(path.join(root, "public", "index.html")));

const port = Number(process.env.PORT) || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`DJ SEBAS MIX STUDIO listening on port ${port}`);
});
