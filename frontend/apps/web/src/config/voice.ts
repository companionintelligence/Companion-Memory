// Voice service configuration
// Replace YOUR_SERVER_IP with your actual server IP address
export const VOICE_CONFIG = {
  // Your server's IP address where the voice service is running
  SERVER_IP: 'dev.companionintelligence.com', // Replace this with your actual server IP

  // Voice service endpoints (via nginx proxy)
  TRANSCRIBE_URL: 'https://dev.companionintelligence.com:8643/stt/transcribe',
  HEALTH_URL: 'https://dev.companionintelligence.com:8643/stt/health',
  TTS_URL: 'https://dev.companionintelligence.com:8643/tts/v1/chat/completions',
};

// Helper function to get the voice service URL
export const getVoiceServiceUrl = (endpoint: string = 'transcribe'): string => {
  const baseUrl = `https://${VOICE_CONFIG.SERVER_IP}:8643`;

  switch (endpoint) {
    case 'transcribe':
      return `${baseUrl}/stt/transcribe`;
    case 'health':
      return `${baseUrl}/stt/health`;
    case 'tts':
      return `${baseUrl}/tts/v1/chat/completions`;
    default:
      return `${baseUrl}/stt/${endpoint}`;
  }
};
