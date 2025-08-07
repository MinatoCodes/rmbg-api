const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const FormData = require("form-data");

const BASE_URL = "https://ecshreve-bg-remover.hf.space";

function generateRandomId(length = 11) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function uploadImage(imagePath) {
  const fullFilePath = path.resolve(imagePath);
  if (!fs.existsSync(fullFilePath)) {
    throw new Error("File not found at: " + fullFilePath);
  }

  const uploadId = generateRandomId();
  const uploadUrl = `${BASE_URL}/upload?upload_id=${uploadId}`;
  const form = new FormData();
  form.append("files", fs.createReadStream(fullFilePath));

  const response = await axios.post(uploadUrl, form, {
    headers: {
      ...form.getHeaders(),
      Origin: BASE_URL,
    },
  });

  const serverPath = response.data[0];
  const stats = fs.statSync(fullFilePath);

  return {
    path: serverPath,
    url: `${BASE_URL}/file=${serverPath}`,
    orig_name: path.basename(fullFilePath),
    size: stats.size,
    mime_type: "image/jpeg",
    meta: { _type: "gradio.FileData" },
  };
}

function processImage(uploadedFileData) {
  return new Promise(async (resolve, reject) => {
    try {
      const sessionHash = generateRandomId();
      const triggerId = 10;

      const joinPayload = {
        data: [uploadedFileData],
        event_data: null,
        fn_index: 0,
        trigger_id: triggerId,
        session_hash: sessionHash,
      };

      await axios.post(`${BASE_URL}/queue/join`, joinPayload, {
        headers: { Origin: BASE_URL },
      });

      const dataUrl = `${BASE_URL}/queue/data?session_hash=${sessionHash}`;
      const response = await axios.get(dataUrl, {
        responseType: "stream",
        headers: {
          Accept: "text/event-stream",
          Origin: BASE_URL,
        },
      });

      const stream = response.data;
      const eventIdsLogged = new Set();

      stream.on("data", (chunk) => {
        const lines = chunk
          .toString()
          .split("\n")
          .filter((line) => line.startsWith("data:"));
        for (const line of lines) {
          try {
            const data = JSON.parse(line.substring(5).trim());

            if (!eventIdsLogged.has(data.event_id)) {
              eventIdsLogged.add(data.event_id);
            }

            if (data.msg === "process_completed") {
              stream.destroy();
              const fileData = data.output?.data?.[0];
              if (fileData?.url) {
                resolve(fileData.url);
              } else {
                reject(new Error("No final image URL found."));
              }
            }
          } catch (_) {}
        }
      });

      stream.on("end", () => reject(new Error("Stream ended without result.")));
      stream.on("error", (err) => reject(err));
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).json({ error: "Missing 'url' query parameter." });
  }

  try {
    const tempDir = path.join(os.tmpdir(), "vercel-rmbg");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const inputPath = path.join(tempDir, `input-${Date.now()}.jpg`);

    const response = await axios.get(imageUrl, { responseType: "stream" });
    const writer = fs.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const uploaded = await uploadImage(inputPath);
    const finalUrl = await processImage(uploaded);

    res.status(200).json({ url: finalUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
      
