#!/usr/bin/env node

/**
 * Audio Transcription API Example
 * 
 * This script demonstrates how to use the STT (Speech-to-Text) endpoint
 * to transcribe audio files.
 * 
 * Usage:
 *   node examples/test-audio-api.js <audio-file-path> <jwt-token>
 * 
 * Example:
 *   node examples/test-audio-api.js ./test-audio.wav "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 */

const fs = require('fs');
const path = require('path');

// Mock FormData and fetch for demonstration
const FormData = require('form-data') || class FormData { 
  append() {} 
  getHeaders() { return {}; } 
};

async function transcribeAudio(audioFilePath, jwtToken) {
  try {
    // Check if file exists
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    // Example using built-in fetch (Node 18+) or require node-fetch
    const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3030';
    
    console.log('📤 Uploading audio file for transcription...');
    console.log('📁 File:', audioFilePath);
    console.log('🔗 Endpoint:', `${API_BASE_URL}/stt`);

    // For demonstration - in real usage you'd use FormData and fetch
    console.log('🔧 Example fetch request:');
    console.log(`
const formData = new FormData();
formData.append('file', fs.createReadStream('${audioFilePath}'));

const response = await fetch('${API_BASE_URL}/stt', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${jwtToken}',
    ...formData.getHeaders(),
  },
  body: formData,
});

const result = await response.json();
console.log('Transcription:', result.text);
    `);

    return { 
      text: 'This is a sample transcription result',
      confidence: 0.95,
      duration: 5.2 
    };

  } catch (error) {
    console.error('❌ Transcription failed:', error.message);
    throw error;
  }
}

async function convertTextToSpeech(text, jwtToken) {
  try {
    const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3030';
    
    console.log('🗣️  Converting text to speech...');
    console.log('📝 Text:', text);
    console.log('🔗 Endpoint:', `${API_BASE_URL}/tts`);

    console.log('🔧 Example fetch request:');
    console.log(`
const response = await fetch('${API_BASE_URL}/tts', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${jwtToken}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ text: '${text}' }),
});

const audioBlob = await response.blob();
// Save or play the audio blob
    `);

    console.log('✅ Text-to-speech example completed!');
    
    return 'tts-output-example.wav';

  } catch (error) {
    console.error('❌ Text-to-speech failed:', error.message);
    throw error;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('🎤 Audio Transcription API Demo');
    console.log('=================================');
    console.log('');
    console.log('This demonstrates the backend API endpoints for audio transcription.');
    console.log('');
    console.log('Available endpoints:');
    console.log('  POST /stt - Speech-to-Text (accepts audio files)');
    console.log('  POST /tts - Text-to-Speech (accepts text, returns audio)');
    console.log('');
    console.log('Both endpoints require JWT authentication.');
    console.log('');
    console.log('Usage: node test-audio-api.js [demo-file-path]');
    console.log('');
    console.log('Example cURL commands:');
    console.log('');
    console.log('# STT - Upload audio for transcription');
    console.log('curl -X POST http://localhost:3030/stt \\');
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN" \\');
    console.log('  -F "file=@audio.wav"');
    console.log('');
    console.log('# TTS - Convert text to speech');
    console.log('curl -X POST http://localhost:3030/tts \\');
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN" \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log('  -d \'{"text": "Hello, this will become speech"}\'');
    console.log('');
    return;
  }

  const [demoFilePath] = args;

  try {
    console.log('🎤 Running Audio API Demo');
    console.log('==========================');
    
    // Demo STT
    const transcriptionResult = await transcribeAudio(demoFilePath || 'demo-audio.wav', 'demo-jwt-token');
    
    // Demo TTS
    await convertTextToSpeech('Hello, this is a test of the text-to-speech system!', 'demo-jwt-token');

    console.log('🎉 Demo completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Start the backend server: yarn dev');
    console.log('2. Get a JWT token by authenticating');
    console.log('3. Test with real audio files using the cURL examples above');

  } catch (error) {
    console.error('💥 Demo failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  transcribeAudio,
  convertTextToSpeech,
};