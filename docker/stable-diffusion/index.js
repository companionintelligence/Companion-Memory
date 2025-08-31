const express = require('express');
const { createCanvas } = require('canvas');
const cors = require('cors');

const app = express();
const PORT = 7860;

app.use(cors());
app.use(express.json());

// Helper function to create a styled placeholder image
function createPlaceholderImage(prompt, width = 1024, height = 1024) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Create gradient background
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#667eea');
  gradient.addColorStop(0.5, '#764ba2');
  gradient.addColorStop(1, '#f093fb');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Add decorative overlay
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillRect(0, 0, width, height * 0.2);
  
  // Add geometric shapes
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.beginPath();
  ctx.arc(width * 0.2, height * 0.3, width * 0.1, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.beginPath();
  ctx.arc(width * 0.8, height * 0.7, width * 0.08, 0, Math.PI * 2);
  ctx.fill();

  // Add prompt text
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.max(16, width / 35)}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Word wrap the prompt
  const words = prompt.split(' ');
  const lines = [];
  let currentLine = '';
  const maxCharsPerLine = Math.max(15, width / 25);

  for (const word of words) {
    if ((currentLine + ' ' + word).length > maxCharsPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  // Draw text lines (limit to 3 lines for better fit)
  const lineHeight = Math.max(24, width / 25);
  const startY = height / 2 - ((lines.slice(0, 3).length - 1) * lineHeight) / 2;
  
  lines.slice(0, 3).forEach((line, index) => {
    // Add text shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillText(line, width / 2 + 2, startY + index * lineHeight + 2);
    
    // Add main text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, width / 2, startY + index * lineHeight);
  });

  // Add watermark
  ctx.font = `${Math.max(12, width / 50)}px Arial, sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.textAlign = 'right';
  ctx.fillText('🎨 Local AI', width - 15, height - 15);

  return canvas.toBuffer('image/png');
}

// Health check endpoint
app.get('/internal/ping', (req, res) => {
  res.json({ status: 'ok', message: 'Local AI Image Generation API is running' });
});

// Main text-to-image endpoint compatible with Stable Diffusion Web UI API
app.post('/sdapi/v1/txt2img', (req, res) => {
  try {
    const {
      prompt,
      negative_prompt = '',
      width = 1024,
      height = 1024,
      steps = 20,
      cfg_scale = 7.0,
      seed = -1,
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log(`Generating image for: ${prompt.substring(0, 50)}...`);

    // Generate placeholder image
    const imageBuffer = createPlaceholderImage(prompt, width, height);
    const imageBase64 = imageBuffer.toString('base64');

    const finalSeed = seed === -1 ? Math.floor(Math.random() * (2**32)) : seed;

    const response = {
      images: [imageBase64],
      parameters: {
        prompt,
        negative_prompt,
        width,
        height,
        steps,
        cfg_scale,
        seed: finalSeed,
      },
      info: `Local AI generated image ${width}x${height} with ${steps} steps`,
    };

    console.log('Image generated successfully');
    res.json(response);
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ error: 'Image generation failed', details: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Local AI Image Generation API',
    version: '1.0.0',
    status: 'ready',
    capabilities: ['txt2img'],
    docs: '/docs'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎨 Local AI Image Generation API running on port ${PORT}`);
  console.log('✅ Ready to generate images with embedded prompt text');
  console.log('🔗 Health check: http://localhost:7860/internal/ping');
  console.log('📖 API docs: http://localhost:7860/');
});