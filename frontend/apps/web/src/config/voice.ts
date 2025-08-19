// Voice service configuration
// Replace YOUR_SERVER_IP with your actual server IP address
export const VOICE_CONFIG = {
  // Your server's IP address where the voice service is running
  SERVER_IP: 'dev.companionintelligence.com', // Replace this with your actual server IP

  // Voice service endpoints
  TRANSCRIBE_URL: 'http://dev.companionintelligence.com:9002/transcribe',
  HEALTH_URL: 'http://dev.companionintelligence.com:9002/health',
  TTS_URL: 'http://dev.companionintelligence.com:9002/tts',
};

// Helper function to get the voice service URL
export const getVoiceServiceUrl = (endpoint: string = 'transcribe'): string => {
  const baseUrl = `http://${VOICE_CONFIG.SERVER_IP}:9002`;

  switch (endpoint) {
    case 'transcribe':
      return `${baseUrl}/transcribe`;
    case 'health':
      return `${baseUrl}/health`;
    case 'tts':
      return `${baseUrl}/tts`;
    default:
      return `${baseUrl}/${endpoint}`;
  }
};
