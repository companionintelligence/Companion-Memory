import { useState, useRef } from 'react';
import { Button, Card, Input, Label, Textarea, Alert, Badge, Progress } from '@ci/shadcn';
import { Mic, Upload, CheckCircle, AlertCircle, Loader2, Pause } from '@ci/shadcn/icons';

interface VoiceProfile {
  id: string;
  name: string;
  description?: string;
  language: string;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

interface VoiceSample {
  id: string;
  profile_id: string;
  filename: string;
  duration?: number;
  sample_rate: number;
  uploaded_at: string;
}

type WizardStep = 'create' | 'upload' | 'review' | 'complete';

export function VoiceCloningWizard() {
  const [currentStep, setCurrentStep] = useState<WizardStep>('create');
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [samples, setSamples] = useState<VoiceSample[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  
  // Form state
  const [profileName, setProfileName] = useState('');
  const [profileDescription, setProfileDescription] = useState('');
  const [profileLanguage, setProfileLanguage] = useState('en');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const createProfile = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/voicebox/profile/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: profileName,
          description: profileDescription,
          language: profileLanguage,
        }),
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create profile');
      }

      const data = await response.json();
      setProfile(data);
      setCurrentStep('upload');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
    } finally {
      setIsLoading(false);
    }
  };

  const uploadSample = async (file: File) => {
    if (!profile) return;

    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('profile_id', profile.id);
      formData.append('audio_file', file);

      const response = await fetch('/api/voicebox/sample/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to upload sample');
      }

      const data = await response.json();
      setSamples([...samples, data.sample]);
      
      // Update profile sample count
      setProfile({
        ...profile,
        sample_count: profile.sample_count + 1,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload sample');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      await uploadSample(files[i]);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioFile = new File([audioBlob], `recording-${Date.now()}.webm`, { type: 'audio/webm' });
        await uploadSample(audioFile);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      setError('Failed to access microphone. Please grant permission and try again.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const resetWizard = () => {
    setCurrentStep('create');
    setProfile(null);
    setSamples([]);
    setProfileName('');
    setProfileDescription('');
    setProfileLanguage('en');
    setError(null);
  };

  const renderCreateStep = () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold mb-2">Create Voice Profile</h3>
        <p className="text-sm text-muted-foreground">
          Start by creating a profile for your custom voice.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <Alert.Title>Error</Alert.Title>
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      )}

      <div className="space-y-3">
        <div>
          <Label htmlFor="voice-name">Voice Name *</Label>
          <Input
            id="voice-name"
            placeholder="e.g., My Voice"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <div>
          <Label htmlFor="voice-description">Description</Label>
          <Textarea
            id="voice-description"
            placeholder="Optional description of this voice..."
            value={profileDescription}
            onChange={(e) => setProfileDescription(e.target.value)}
            disabled={isLoading}
            rows={3}
          />
        </div>

        <div>
          <Label htmlFor="voice-language">Language</Label>
          <select
            id="voice-language"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
            value={profileLanguage}
            onChange={(e) => setProfileLanguage(e.target.value)}
            disabled={isLoading}
          >
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button
          onClick={createProfile}
          disabled={!profileName.trim() || isLoading}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            'Create Profile'
          )}
        </Button>
      </div>
    </div>
  );

  const renderUploadStep = () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold mb-2">Upload Voice Samples</h3>
        <p className="text-sm text-muted-foreground">
          Upload or record at least 3 audio samples (5-30 seconds each) for best results.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <Alert.Title>Error</Alert.Title>
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      )}

      {profile && (
        <Card>
          <Card.Content className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="font-medium">{profile.name}</p>
                <p className="text-sm text-muted-foreground">
                  {profile.sample_count} sample{profile.sample_count !== 1 ? 's' : ''} uploaded
                </p>
              </div>
              <Badge variant={profile.sample_count >= 3 ? 'default' : 'secondary'}>
                {profile.sample_count >= 3 ? 'Ready' : 'Needs more samples'}
              </Badge>
            </div>
            
            {profile.sample_count < 10 && (
              <Progress value={(profile.sample_count / 10) * 100} className="mb-4" />
            )}
          </Card.Content>
        </Card>
      )}

      <div className="grid gap-3">
        <Button
          variant="outline"
          className="justify-start h-auto py-4"
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading}
        >
          <Upload className="mr-2 h-5 w-5" />
          <div className="text-left">
            <div className="font-medium">Upload Audio Files</div>
            <div className="text-xs text-muted-foreground">
              WAV, MP3, or other audio formats
            </div>
          </div>
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <Button
          variant="outline"
          className="justify-start h-auto py-4"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isLoading}
        >
          {isRecording ? (
            <>
              <Pause className="mr-2 h-5 w-5 text-red-500" />
              <div className="text-left">
                <div className="font-medium">Stop Recording</div>
                <div className="text-xs text-muted-foreground">
                  Click to stop and upload
                </div>
              </div>
            </>
          ) : (
            <>
              <Mic className="mr-2 h-5 w-5" />
              <div className="text-left">
                <div className="font-medium">Record Audio</div>
                <div className="text-xs text-muted-foreground">
                  Record directly from your microphone
                </div>
              </div>
            </>
          )}
        </Button>
      </div>

      {samples.length > 0 && (
        <div className="space-y-2">
          <Label>Uploaded Samples</Label>
          <div className="space-y-2">
            {samples.map((sample, index) => (
              <div
                key={sample.id}
                className="flex items-center justify-between p-3 rounded-md border"
              >
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <div>
                    <p className="text-sm font-medium">Sample {index + 1}</p>
                    <p className="text-xs text-muted-foreground">
                      {sample.duration ? `${sample.duration.toFixed(1)}s` : 'Processing...'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-between gap-2 pt-4">
        <Button variant="outline" onClick={resetWizard}>
          Cancel
        </Button>
        <Button
          onClick={() => setCurrentStep('review')}
          disabled={!profile || profile.sample_count < 3}
        >
          Continue
        </Button>
      </div>
    </div>
  );

  const renderReviewStep = () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold mb-2">Review & Complete</h3>
        <p className="text-sm text-muted-foreground">
          Your voice profile is ready! You can now use it for text-to-speech synthesis.
        </p>
      </div>

      {profile && (
        <Card>
          <Card.Content className="pt-6 space-y-4">
            <div>
              <Label>Voice Name</Label>
              <p className="text-sm">{profile.name}</p>
            </div>
            {profile.description && (
              <div>
                <Label>Description</Label>
                <p className="text-sm text-muted-foreground">{profile.description}</p>
              </div>
            )}
            <div>
              <Label>Language</Label>
              <p className="text-sm">{profile.language}</p>
            </div>
            <div>
              <Label>Samples</Label>
              <p className="text-sm">{profile.sample_count} audio samples</p>
            </div>
          </Card.Content>
        </Card>
      )}

      <Alert>
        <CheckCircle className="h-4 w-4" />
        <Alert.Title>Voice Profile Created</Alert.Title>
        <Alert.Description>
          Your voice is now available for use in the TTS system. You can add more samples later to
          improve quality.
        </Alert.Description>
      </Alert>

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={resetWizard}>
          Create Another
        </Button>
        <Button onClick={() => setCurrentStep('complete')}>
          Done
        </Button>
      </div>
    </div>
  );

  const renderCompleteStep = () => (
    <div className="space-y-4 text-center py-8">
      <div className="flex justify-center mb-4">
        <div className="rounded-full bg-green-100 dark:bg-green-900 p-4">
          <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
        </div>
      </div>
      <div>
        <h3 className="text-xl font-semibold mb-2">Voice Cloning Complete!</h3>
        <p className="text-muted-foreground">
          Your custom voice is ready to use.
        </p>
      </div>
      <Button onClick={resetWizard}>
        Create Another Voice
      </Button>
    </div>
  );

  return (
    <Card>
      <Card.Content className="pt-6">
        {currentStep === 'create' && renderCreateStep()}
        {currentStep === 'upload' && renderUploadStep()}
        {currentStep === 'review' && renderReviewStep()}
        {currentStep === 'complete' && renderCompleteStep()}
      </Card.Content>
    </Card>
  );
}
