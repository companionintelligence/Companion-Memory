# Home Assistant Integration Guide

This comprehensive Home Assistant integration provides OAuth2 authentication and extensive automation capabilities for self-hosted Home Assistant instances.

## Setup and Authentication

### 1. Configure Home Assistant OAuth Application
In your Home Assistant instance:
1. Go to Settings > People > Users & Security
2. Create a new "Application" under API
3. Set the redirect URI to: `https://dev.companionintelligence.com/oauth/callback`
4. Copy the Client ID and Client Secret

### 2. Create Connection in CI Server
```bash
POST /connections
{
  "name": "My Home Assistant",
  "providerId": "0198779b-4d44-84eb-95f6-93f1ea256371",
  "clientid": "your-client-id-here",
  "clientsecret": "your-client-secret-here",
  "clientkey": "https://your-ha-instance.duckdns.org:8123"  // Your HA URL
}
```

### 3. Complete OAuth Flow
1. Use the connection ID to initiate OAuth: `GET /connections/{id}/connect`
2. Follow the OAuth flow to authorize access
3. Connection is now ready for automation

## API Endpoints

### Dashboard and Status
- `GET /connections/home-assistant/{connectionId}/dashboard` - Complete status overview
- `GET /connections/home-assistant/{connectionId}/sync` - Sync all data with analytics

### Location Tracking
- `GET /connections/home-assistant/{connectionId}/location/persons` - Get all people
- `GET /connections/home-assistant/{connectionId}/location/person/{personId}` - Get specific person location
- `GET /connections/home-assistant/{connectionId}/location/device-trackers` - Get all device trackers
- `GET /connections/home-assistant/{connectionId}/location/zones` - Get all zones
- `POST /connections/home-assistant/{connectionId}/location/person/{personId}/handle-change` - Trigger location automations

### Media Control
- `GET /connections/home-assistant/{connectionId}/media/players` - Get all media players
- `GET /connections/home-assistant/{connectionId}/media/active` - Get active media players
- `GET /connections/home-assistant/{connectionId}/media/playing` - Get currently playing media
- `GET /connections/home-assistant/{connectionId}/media/insights` - Get media consumption insights
- `POST /connections/home-assistant/{connectionId}/media/pause-all` - Pause all playing media
- `POST /connections/home-assistant/{connectionId}/media/{entityId}/control` - Control specific media player

### Light Control
- `GET /connections/home-assistant/{connectionId}/lights` - Get all lights
- `POST /connections/home-assistant/{connectionId}/lights/turn-on` - Turn on lights with options
- `POST /connections/home-assistant/{connectionId}/lights/turn-off` - Turn off lights
- `POST /connections/home-assistant/{connectionId}/lights/toggle` - Toggle lights
- `POST /connections/home-assistant/{connectionId}/lights/set-brightness` - Set brightness
- `POST /connections/home-assistant/{connectionId}/lights/set-color` - Set RGB color
- `POST /connections/home-assistant/{connectionId}/lights/adaptive` - Auto-adjust lights based on time/activity
- `POST /connections/home-assistant/{connectionId}/lights/scenario` - Set lighting scenario

### Security and Cameras
- `GET /connections/home-assistant/{connectionId}/cameras` - Get all cameras
- `GET /connections/home-assistant/{connectionId}/cameras/{entityId}/image` - Get camera image
- `POST /connections/home-assistant/{connectionId}/cameras/{entityId}/snapshot` - Take snapshot
- `GET /connections/home-assistant/{connectionId}/security/status` - Get security status
- `POST /connections/home-assistant/{connectionId}/security/snapshot` - Capture security snapshots from all cameras

### Automations and Scenes
- `GET /connections/home-assistant/{connectionId}/automations` - Get all automations
- `GET /connections/home-assistant/{connectionId}/scenes` - Get all scenes
- `POST /connections/home-assistant/{connectionId}/automations/{entityId}/trigger` - Trigger automation
- `POST /connections/home-assistant/{connectionId}/scenes/{entityId}/activate` - Activate scene

### Notifications
- `POST /connections/home-assistant/{connectionId}/notify` - Send notification
- `POST /connections/home-assistant/{connectionId}/tts` - Send TTS announcement

### Voice Commands
- `POST /connections/home-assistant/{connectionId}/voice/process` - Process voice command with intelligence
- `POST /connections/home-assistant/{connectionId}/conversation` - Use Home Assistant's built-in conversation

### Generic Service Calls
- `POST /connections/home-assistant/{connectionId}/service` - Call any Home Assistant service

## Usage Examples

### Location Tracking
Monitor when you come and go from your house:
```bash
# Get current location of a person
GET /connections/home-assistant/{connectionId}/location/person/john

# Trigger automations when location changes
POST /connections/home-assistant/{connectionId}/location/person/john/handle-change
```

### Media Control
Track and control your media consumption:
```bash
# See what's currently playing
GET /connections/home-assistant/{connectionId}/media/insights

# Pause everything when getting a phone call
POST /connections/home-assistant/{connectionId}/media/pause-all

# Control specific device
POST /connections/home-assistant/{connectionId}/media/living_room_tv/control
{
  "action": "pause"
}
```

### Smart Lighting
Intelligent light control based on context:
```bash
# Auto-adjust lights based on time and activity
POST /connections/home-assistant/{connectionId}/lights/adaptive

# Create movie ambiance
POST /connections/home-assistant/{connectionId}/lights/scenario
{
  "scenario": "movie"
}

# Set specific color
POST /connections/home-assistant/{connectionId}/lights/set-color
{
  "entity_id": "light.living_room",
  "color": { "r": 255, "g": 100, "b": 50 }
}
```

### Security Integration
Monitor and record security events:
```bash
# Check security status
GET /connections/home-assistant/{connectionId}/security/status

# Capture security snapshots
POST /connections/home-assistant/{connectionId}/security/snapshot
{
  "reason": "Motion detected at front door"
}
```

### Voice Commands
Process natural language commands:
```bash
# Process voice command with intelligent automation
POST /connections/home-assistant/{connectionId}/voice/process
{
  "command": "Turn on the living room lights and set them to 50% brightness"
}

# Use Home Assistant's conversation AI
POST /connections/home-assistant/{connectionId}/conversation
{
  "text": "What's the temperature in the bedroom?",
  "language": "en"
}
```

### Automation Scenarios

#### Welcome Home Automation
When location tracking detects you've arrived home:
1. Automatically triggered via `POST /location/person/{id}/handle-change`
2. Turns on welcome scene
3. Sends welcome notification
4. Captures security snapshot for arrival

#### Evening Routine
```bash
# Trigger adaptive lighting for evening
POST /connections/home-assistant/{connectionId}/lights/adaptive
# Response: Sets warm, dim lighting based on current time

# Check what's playing and pause if needed for dinner
GET /connections/home-assistant/{connectionId}/media/insights
POST /connections/home-assistant/{connectionId}/media/pause-all
```

#### Security Monitoring
```bash
# Get comprehensive dashboard with security status
GET /connections/home-assistant/{connectionId}/dashboard

# Automated security snapshot when motion detected
POST /connections/home-assistant/{connectionId}/security/snapshot
{
  "reason": "Motion sensor triggered - garage door"
}
```

## Integration Features

### Intelligent Automations
- **Location-based**: Lights and scenes triggered by presence
- **Context-aware**: Lighting adjusts based on time and media activity
- **Security-first**: Automatic snapshots and monitoring
- **Voice-activated**: Natural language command processing

### Real-time Monitoring
- **Comprehensive dashboard**: Single endpoint for all status information
- **Analytics**: Usage patterns and insights across all domains
- **Proactive alerts**: Security notifications and recommendations

### Extensible Architecture
- **Modular design**: Easy to add new automation scenarios
- **Type-safe**: Full TypeScript typing for all Home Assistant entities
- **Error handling**: Graceful degradation when devices are unavailable
- **Logging**: Comprehensive logging for debugging and monitoring

This integration transforms your Home Assistant setup from a smart home controller into an intelligent automation platform that learns and adapts to your lifestyle patterns.