const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 7860;

app.use(cors());
app.use(express.json());

// Model configurations
const MODEL_CONFIGS = {
  'flux-schnell': {
    name: 'FLUX.1 Schnell',
    description: 'Fast high-quality generation (4 steps)',
    icon: '⚡',
    color: '#0096FF',
    defaultSteps: 4,
    defaultCfgScale: 1.0
  },
  'flux-dev': {
    name: 'FLUX.1 Dev',
    description: 'Highest quality generation (28 steps)',
    icon: '🔥',
    color: '#FF6400',
    defaultSteps: 28,
    defaultCfgScale: 3.5
  },
  'sdxl': {
    name: 'Stable Diffusion XL',
    description: 'High quality 1024x1024 native resolution',
    icon: '🎯',
    color: '#00C864',
    defaultSteps: 20,
    defaultCfgScale: 7.0
  },
  'sd15': {
    name: 'Stable Diffusion 1.5',
    description: 'Lightweight fallback model',
    icon: '🎨',
    color: '#6464FF',
    defaultSteps: 20,
    defaultCfgScale: 7.0
  }
};

// Helper function to create an SVG placeholder image
function createModelPlaceholderSVG(prompt, model = 'flux-schnell', width = 1024, height = 1024) {
  const modelConfig = MODEL_CONFIGS[model] || MODEL_CONFIGS['flux-schnell'];
  const { color, icon, name } = modelConfig;

  // Create SVG with model-specific styling
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${color};stop-opacity:1" />
          <stop offset="50%" style="stop-color:${color}88;stop-opacity:1" />
          <stop offset="100%" style="stop-color:${color}44;stop-opacity:1" />
        </linearGradient>
        <filter id="shadow">
          <feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.3"/>
        </filter>
      </defs>
      
      <rect width="100%" height="100%" fill="url(#gradient)"/>
      
      <!-- Decorative overlay -->
      <rect width="100%" height="20%" fill="rgba(255,255,255,0.1)"/>
      
      <!-- Geometric shapes -->
      <circle cx="20%" cy="30%" r="10%" fill="rgba(255,255,255,0.3)"/>
      <circle cx="80%" cy="70%" r="8%" fill="rgba(255,255,255,0.2)"/>
      
      <!-- Model name -->
      <text x="50%" y="16%" text-anchor="middle" font-family="Arial, sans-serif" 
            font-size="${Math.max(18, width/30)}px" font-weight="bold" fill="white" filter="url(#shadow)">
        ${icon} ${name}
      </text>
      
      <!-- Prompt text -->
      <text x="50%" y="45%" text-anchor="middle" font-family="Arial, sans-serif" 
            font-size="${Math.max(16, width/35)}px" fill="white" filter="url(#shadow)">
        <tspan x="50%" dy="0">${prompt.length > 40 ? prompt.substring(0, 37) + '...' : prompt}</tspan>
      </text>
      
      <!-- Technical info -->
      <text x="50%" y="75%" text-anchor="middle" font-family="Arial, sans-serif" 
            font-size="${Math.max(12, width/50)}px" fill="rgba(255,255,255,0.8)">
        ${model.toUpperCase()} • ${width}×${height}
      </text>
      
      <!-- Watermark -->
      <text x="98%" y="98%" text-anchor="end" font-family="Arial, sans-serif" 
            font-size="${Math.max(12, width/50)}px" fill="rgba(255,255,255,0.7)">
        🤖 Local AI
      </text>
    </svg>
  `;

  return Buffer.from(svg);
}

// Convert SVG to base64 PNG
function svgToBase64PNG(svgBuffer) {
  // For now, return the SVG as base64 (browsers can handle it)
  // In a real implementation, we'd convert SVG to PNG
  return svgBuffer.toString('base64');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Multi-Model AI Image Generation API is running',
    version: '2.0.0',
    mode: 'placeholder',
    models: Object.keys(MODEL_CONFIGS)
  });
});

// Legacy health check endpoint
app.get('/internal/ping', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Multi-Model AI Image Generation API is running',
    version: '2.0.0',
    mode: 'placeholder' 
  });
});

// Models endpoint
app.get('/models', (req, res) => {
  const models = Object.entries(MODEL_CONFIGS).map(([id, config]) => ({
    id,
    name: config.name,
    description: config.description,
    icon: config.icon,
    color: config.color,
    defaultSteps: config.defaultSteps,
    defaultCfgScale: config.defaultCfgScale,
    available: true,
    mode: 'placeholder'
  }));
  
  res.json({ models });
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
      model = 'flux-schnell',
      sampler_name = 'DPM++ 2M Karras',
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Validate model
    const selectedModel = MODEL_CONFIGS[model] ? model : 'flux-schnell';
    const modelConfig = MODEL_CONFIGS[selectedModel];

    console.log(`Generating ${selectedModel} placeholder for: ${prompt.substring(0, 50)}...`);

    // Generate model-specific placeholder image
    const svgBuffer = createModelPlaceholderSVG(prompt, selectedModel, width, height);
    
    // Create a simple PNG placeholder (we'll use a colored rectangle with text info)
    const simpleImageData = createSimplePNGPlaceholder(prompt, selectedModel, width, height);
    const imageBase64 = simpleImageData;

    const finalSeed = seed === -1 ? Math.floor(Math.random() * (2**32)) : seed;

    // Use model-specific defaults
    const finalSteps = steps || modelConfig.defaultSteps;
    const finalCfgScale = cfg_scale || modelConfig.defaultCfgScale;

    const response = {
      images: [imageBase64],
      parameters: {
        prompt,
        negative_prompt,
        width,
        height,
        steps: finalSteps,
        cfg_scale: finalCfgScale,
        seed: finalSeed,
        model: selectedModel,
        sampler_name,
      },
      info: `${modelConfig.name} placeholder generated ${width}x${height} image with ${finalSteps} steps (cfg: ${finalCfgScale})`,
    };

    console.log(`${modelConfig.name} placeholder generated successfully`);
    res.json(response);
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({ 
      error: 'Image generation failed', 
      details: error.message 
    });
  }
});

// Simple PNG placeholder without canvas dependency
function createSimplePNGPlaceholder(prompt, model, width, height) {
  // Create a simple base64 encoded 1x1 pixel PNG as placeholder
  // This is a minimal PNG that browsers can display
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0x99, 0x01, 0x01, 0x00, 0x00, 0x00, // Image data
    0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x02, 0x00, 
    0x01, 0xE5, 0x27, 0xDE, 0xFC, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82 // IEND chunk
  ]);
  
  return pngHeader.toString('base64');
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Multi-Model AI Image Generation API',
    version: '2.0.0',
    status: 'ready',
    mode: 'placeholder',
    models: Object.keys(MODEL_CONFIGS),
    capabilities: ['txt2img', 'model_selection', 'sdxl', 'flux'],
    features: [
      'FLUX.1-schnell: Fast generation (4 steps)',
      'FLUX.1-dev: Highest quality (28 steps)', 
      'SDXL: Native 1024x1024 resolution',
      'SD 1.5: Lightweight fallback'
    ],
    endpoints: {
      generate: '/sdapi/v1/txt2img',
      models: '/models',
      health: '/health'
    },
    docs: '/docs'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎨 Multi-Model AI Image Generation API running on port ${PORT}`);
  console.log(`🤖 Available models: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
  console.log('✨ Features: FLUX.1-schnell, FLUX.1-dev, SDXL, SD 1.5');
  console.log('ℹ️  Currently running in placeholder mode');
  console.log('📋 Model details:');
  Object.entries(MODEL_CONFIGS).forEach(([id, config]) => {
    console.log(`   ${config.icon} ${config.name}: ${config.description}`);
  });
  console.log('🔗 Health check: http://localhost:7860/health');
  console.log('📖 API docs: http://localhost:7860/');
});