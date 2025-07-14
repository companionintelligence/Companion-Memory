#!/usr/bin/env node

/**
 * Example client for the enhanced Camera API
 * This demonstrates how to use the new media analysis endpoints
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

class CameraAPIClient {
  constructor(baseUrl = 'https://localhost', authToken = null) {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
  }

  /**
   * Analyze media file (image, video, or audio)
   * @param {string} filePath - Path to the media file
   * @param {Object} options - Analysis options
   * @param {string} options.analysisType - 'people', 'places', 'objects', or 'comprehensive'
   * @param {string} [options.model] - Optional: specific model to use
   * @param {boolean} [options.includeMetadata] - Include metadata in results
   * @param {string} [options.threadId] - Optional: thread ID for conversation context
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeMedia(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const {
      analysisType = 'comprehensive',
      model,
      includeMetadata = true,
      threadId
    } = options;

    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('analysisType', analysisType);
    
    if (model) {
      formData.append('model', model);
    }
    
    if (includeMetadata !== undefined) {
      formData.append('includeMetadata', includeMetadata.toString());
    }
    
    if (threadId) {
      formData.append('threadId', threadId);
    }

    const headers = {
      ...formData.getHeaders(),
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/llm/analyze-media`, {
        method: 'POST',
        headers,
        body: formData,
        // Disable SSL verification for development
        ...(this.baseUrl.includes('localhost') && {
          agent: require('https').Agent({ rejectUnauthorized: false })
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to analyze media: ${error.message}`);
    }
  }

  /**
   * Get available LLM models
   * @returns {Promise<Array>} List of available models
   */
  async getAvailableModels() {
    const headers = {};
    
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/llm/models`, {
        headers,
        // Disable SSL verification for development
        ...(this.baseUrl.includes('localhost') && {
          agent: require('https').Agent({ rejectUnauthorized: false })
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to get models: ${error.message}`);
    }
  }

  /**
   * Upload a file to the server for later processing
   * @param {string} filePath - Path to the file
   * @returns {Promise<Object>} Upload result with file ID
   */
  async uploadFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));

    const headers = {
      ...formData.getHeaders(),
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/files/upload`, {
        method: 'POST',
        headers,
        body: formData,
        // Disable SSL verification for development
        ...(this.baseUrl.includes('localhost') && {
          agent: require('https').Agent({ rejectUnauthorized: false })
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to upload file: ${error.message}`);
    }
  }
}

// Example usage
async function main() {
  // Initialize the client
  const client = new CameraAPIClient('https://localhost', process.env.AUTH_TOKEN);

  try {
    // Example 1: Analyze an image for people
    console.log('🔍 Analyzing image for people...');
    const imageAnalysis = await client.analyzeMedia('./test-image.jpg', {
      analysisType: 'people',
      includeMetadata: true
    });
    console.log('📸 Image Analysis Results:', JSON.stringify(imageAnalysis, null, 2));

    // Example 2: Comprehensive analysis of a video
    console.log('\n🎥 Analyzing video comprehensively...');
    const videoAnalysis = await client.analyzeMedia('./test-video.mp4', {
      analysisType: 'comprehensive'
    });
    console.log('🎬 Video Analysis Results:', JSON.stringify(videoAnalysis, null, 2));

    // Example 3: Get available models
    console.log('\n🤖 Getting available models...');
    const models = await client.getAvailableModels();
    console.log('📋 Available Models:', models);

    // Example 4: Upload a file first, then analyze
    console.log('\n📤 Uploading file...');
    const uploadResult = await client.uploadFile('./test-image.jpg');
    console.log('✅ Upload successful:', uploadResult);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the example if this script is executed directly
if (require.main === module) {
  main();
}

module.exports = CameraAPIClient;
