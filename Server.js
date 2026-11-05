
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "DJ SEBAS AI VIDEO",
    message: "Servidor conectado correctamente"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/generate", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Debes subir una imagen"
      });
    }

    if (!process.env.FAL_KEY) {
      return res.status(500).json({
        error: "Falta configurar FAL_KEY en Render"
      });
    }

    return res.status(501).json({
      status: "pending",
      message: "Servidor preparado. Falta conectar el modelo de video."
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DJ SEBAS AI VIDEO activo en puerto ${PORT}`);
});

