import { Ollama } from 'ollama';

// Test script to reproduce the Ollama connection issue
async function testOllamaConnection() {
  console.log('Testing Ollama connection...');
  
  const ollama = new Ollama({
    host: 'http://localhost:11434',
  });

  try {
    console.log('Attempting to list models...');
    const result = await ollama.list();
    console.log('Success! Models:', result.models.map((m: any) => m.name));
  } catch (error: any) {
    console.error('Error connecting to Ollama:', error.message);
    console.error('Error type:', error.constructor.name);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
  }
}

testOllamaConnection();