const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3100;

app.use(cors());
app.use(express.json());

// Serve the test tool UI
app.use(express.static(__dirname));

// Serve result images
const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir);
app.use('/results', express.static(resultsDir));

// Upload handling
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const upload = multer({ dest: uploadsDir });

// Model configs
const MODELS = {
  'gemini-flash': { name: 'Gemini 2.5 Flash', model: 'gemini-2.5-flash-image', cost: 'free' },
  'gemini-pro': { name: 'Gemini 2.0 Pro', model: 'gemini-2.0-flash-exp-image-generation', cost: 'free' },
  'openai': { name: 'OpenAI gpt-image-1', model: 'gpt-image-1', cost: '~$0.02-0.08' },
  'dalle3': { name: 'DALL-E 3', model: 'dall-e-3', cost: '~$0.04' },
};

app.post('/api/generate', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  
  const modelKey = req.body.model || 'gemini-flash';
  const prompt = req.body.prompt || 'Stage this empty room with modern furniture';
  const modelConfig = MODELS[modelKey];
  
  if (!modelConfig) return res.status(400).json({ error: `Unknown model: ${modelKey}` });
  
  // Rename file to keep extension
  const ext = path.extname(req.file.originalname) || '.jpg';
  const inputPath = req.file.path + ext;
  fs.renameSync(req.file.path, inputPath);
  
  const jobId = crypto.randomUUID().slice(0, 8);
  const outputPath = path.join(resultsDir, `${jobId}${ext}`);
  
  try {
    if (modelKey.startsWith('gemini')) {
      await generateGemini(modelConfig.model, inputPath, prompt, outputPath);
    } else if (modelKey === 'openai') {
      await generateOpenAI(inputPath, prompt, outputPath);
    } else if (modelKey === 'dalle3') {
      await generateDalle3(inputPath, prompt, outputPath);
    }
    
    // Cleanup input
    fs.unlinkSync(inputPath);
    
    res.json({ 
      resultUrl: `/results/${jobId}${ext}`,
      model: modelConfig.name,
      cost: modelConfig.cost 
    });
  } catch (err) {
    console.error(`[${modelKey}] Error:`, err.message);
    res.json({ error: err.message });
  }
});

async function generateGemini(model, inputPath, prompt, outputPath) {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');
  
  const ai = new GoogleGenAI({ apiKey });
  
  // Read image as base64
  const imageBytes = fs.readFileSync(inputPath);
  const base64 = imageBytes.toString('base64');
  const mimeType = inputPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  
  const response = await ai.models.generateContent({
    model,
    contents: [
      { 
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64 } }
        ]
      }
    ],
    config: { responseModalities: ['TEXT', 'IMAGE'] }
  });
  
  // Extract image from response
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      const imgBuffer = Buffer.from(part.inlineData.data, 'base64');
      fs.writeFileSync(outputPath, imgBuffer);
      return;
    }
  }
  throw new Error('Model returned no image');
}

async function generateOpenAI(inputPath, prompt, outputPath) {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI();
  
  const imageBytes = fs.readFileSync(inputPath);
  const base64 = imageBytes.toString('base64');
  const mimeType = inputPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  
  const response = await client.images.edit({
    model: 'gpt-image-1',
    image: Buffer.from(imageBytes),
    prompt: prompt,
    size: '1024x1024',
  });
  
  // gpt-image-1 returns base64
  if (response.data[0].b64_json) {
    fs.writeFileSync(outputPath, Buffer.from(response.data[0].b64_json, 'base64'));
  } else if (response.data[0].url) {
    const resp = await fetch(response.data[0].url);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(outputPath, buf);
  }
}

async function generateDalle3(inputPath, prompt, outputPath) {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI();
  
  // DALL-E 3 can't do image editing — just generation from prompt
  // We describe the room and ask for a staged version
  const response = await client.images.generate({
    model: 'dall-e-3',
    prompt: prompt + ' Photorealistic interior photograph for a real estate listing.',
    size: '1024x1024',
    quality: 'standard',
    n: 1,
  });
  
  const url = response.data[0].url;
  const resp = await fetch(url);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
}

app.listen(PORT, () => {
  console.log(`\n🏠 VirtueStage Model Tester running at http://localhost:${PORT}\n`);
});
