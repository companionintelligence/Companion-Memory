import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import config from '@ci/configuration';
import { EventService, Events } from '@ci/domains/events';
import { FileEntity } from '@ci/domains/files/entities/FileEntity';
import { FileService } from '@ci/domains/files/services/FileService';

import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

// Input schema for the tool
const imageGenerationInputSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(4000, 'Prompt too long'),
  style: z.enum(['natural', 'vivid']).optional().default('natural'),
  size: z.enum(['1024x1024', '1792x1024', '1024x1792']).optional().default('1024x1024'),
  quality: z.enum(['standard', 'hd']).optional().default('standard'),
  model: z.enum(['flux-schnell', 'flux-dev', 'sdxl', 'sd15']).optional().default('flux-schnell'),
  editImageUrl: z.string().optional(), // For future image editing functionality
  mask: z.string().optional(), // For future inpainting functionality
});

type ImageGenerationInput = z.infer<typeof imageGenerationInputSchema>;

// Output interface
interface ImageGenerationOutput {
  imageUrl: string;
  fileId: string;
  prompt: string;
  revisedPrompt?: string;
  altText: string;
}

// Stable Diffusion API types
interface StableDiffusionRequest {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps?: number;
  cfg_scale?: number;
  sampler_name?: string;
  seed?: number;
  model?: string;
  restore_faces?: boolean;
  tiling?: boolean;
  do_not_save_samples?: boolean;
  do_not_save_grid?: boolean;
}

interface StableDiffusionResponse {
  images: string[]; // base64 encoded images
  parameters: any;
  info: string;
}

/**
 * Tool to generate images using local AI models (FLUX.1, SDXL, SD 1.5)
 * Integrates with the existing file storage system to save generated images
 */
@Injectable()
export class ImageGenerationTool extends BaseTool<ImageGenerationInput, ImageGenerationOutput> {
  readonly schema = {
    name: 'generate_image',
    description:
      'Generate images using local AI models (FLUX.1, SDXL, or SD 1.5) based on text descriptions. Use this tool when users ask to create, generate, make, or draw images, pictures, artwork, or visual content. FLUX.1 models provide the highest quality. After calling this tool, you MUST display the generated image in your response using this exact markdown format: ![altText](imageUrl). The tool returns imageUrl and altText fields that you should use directly.',
    category: 'ai',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. Be descriptive and specific.',
          minLength: 1,
          maxLength: 4000,
        },
        model: {
          type: 'string',
          enum: ['flux-schnell', 'flux-dev', 'sdxl', 'sd15'],
          description: 'AI model to use. flux-schnell: fast high quality (4 steps), flux-dev: highest quality (28 steps), sdxl: good balance (20 steps), sd15: lightweight (20 steps)',
          default: 'flux-schnell',
        },
        style: {
          type: 'string',
          enum: ['natural', 'vivid'],
          description: 'The style of the generated image. Natural for more subdued, vivid for hyper-real.',
          default: 'natural',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1792x1024', '1024x1792'],
          description: 'The size of the generated image',
          default: '1024x1024',
        },
        quality: {
          type: 'string',
          enum: ['standard', 'hd'],
          description: 'The quality of the generated image',
          default: 'standard',
        },
        editImageUrl: {
          type: 'string',
          description: 'URL of an existing image to edit (for future image editing functionality)',
        },
        mask: {
          type: 'string',
          description: 'Mask for inpainting/editing specific areas (for future functionality)',
        },
      },
      required: ['prompt'],
    },
    examples: [
      {
        input: { prompt: 'A serene mountain landscape at sunset with a lake reflection', model: 'flux-schnell' },
        output: {
          imageUrl: 'https://storage.example.com/generated-image.png',
          fileId: 'uuid-123',
          prompt: 'A serene mountain landscape at sunset with a lake reflection',
          altText: 'A serene mountain landscape at sunset with a lake reflection',
        },
        description: 'Generate a nature landscape with FLUX.1 schnell model',
      },
      {
        input: { prompt: 'A futuristic city with flying cars', style: 'vivid', size: '1792x1024', model: 'flux-dev' },
        output: {
          imageUrl: 'https://storage.example.com/generated-city.png',
          fileId: 'uuid-456',
          prompt: 'A futuristic city with flying cars',
          altText: 'A futuristic city with flying cars',
        },
        description: 'Generate a high-quality sci-fi cityscape with FLUX.1 dev model',
      },
    ],
  };

  constructor(
    private readonly fileService: FileService,
    private readonly eventService: EventService,
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
  ) {
    super();
  }

  protected validateInput(input: unknown): ImageGenerationInput {
    try {
      return imageGenerationInputSchema.parse(input);
    } catch (error) {
      throw new Error(`Invalid input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: ImageGenerationInput,
  ): Promise<ImageGenerationOutput> {
    this.logger.debug('Starting image generation with local AI models', {
      userId: context.userId,
      prompt: input.prompt.substring(0, 100),
      style: input.style,
      size: input.size,
      quality: input.quality,
      model: input.model,
    });

    // Validate AI image generation service is available
    const aiServiceHost = config.services.aiImageGeneration.host;
    if (!aiServiceHost) {
      throw new Error('AI image generation service is not properly configured. Please check your environment variables.');
    }

    try {
      // Check if AI service is available
      await this.checkAIServiceHealth(aiServiceHost);

      // Generate image using local AI models
      const imageBase64 = await this.callAIImageAPI(input, aiServiceHost);

      // Store the generated image
      const file = await this.storeGeneratedImage(context, imageBase64, input.prompt);

      // Get signed URL using the public API
      const signedFile = await this.fileService.findOne(context, file.id);

      this.logger.log('Image generated successfully with local AI', {
        userId: context.userId,
        fileId: file.id,
        prompt: input.prompt.substring(0, 100),
        model: input.model,
      });

      return {
        imageUrl: signedFile.url || '',
        fileId: file.id,
        prompt: input.prompt,
        altText: input.prompt,
      };
    } catch (error) {
      this.logger.error('Image generation failed', {
        userId: context.userId,
        prompt: input.prompt.substring(0, 100),
        model: input.model,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error; // Let the BaseTool handle the error formatting
    }
  }

  private async checkAIServiceHealth(host: string): Promise<void> {
    try {
      const response = await fetch(`${host}/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (!response.ok) {
        throw new Error(`AI image generation service health check failed: ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error('AI image generation service is not responding. Please ensure the service is running.');
      }
      throw new Error(`Cannot connect to AI image generation service at ${host}. Please ensure it's running and accessible.`);
    }
  }

  private async callAIImageAPI(input: ImageGenerationInput, host: string): Promise<string> {
    // Parse size
    const [width, height] = input.size.split('x').map(Number);

    // Model-specific configurations
    let steps = 20;
    let cfgScale = 7.0;
    
    if (input.model === 'flux-schnell') {
      steps = 4; // FLUX schnell is optimized for 4 steps
      cfgScale = 1.0; // FLUX models use lower guidance
    } else if (input.model === 'flux-dev') {
      steps = 28; // FLUX dev works best with more steps
      cfgScale = 3.5; // FLUX models use lower guidance
    } else if (input.model === 'sdxl') {
      steps = input.quality === 'hd' ? 30 : 20;
      cfgScale = input.quality === 'hd' ? 8.0 : 7.0;
    } else if (input.model === 'sd15') {
      steps = input.quality === 'hd' ? 25 : 20;
      cfgScale = input.quality === 'hd' ? 8.0 : 7.0;
    }

    // Enhance prompt based on style and model
    let enhancedPrompt = input.prompt;
    let negativePrompt = '';
    
    // FLUX models use natural language descriptions (BFL style)
    if (input.model === 'flux-schnell' || input.model === 'flux-dev') {
      // FLUX models prefer natural language descriptions without comma-separated tags
      if (input.style === 'vivid') {
        enhancedPrompt = `A hyperrealistic and highly detailed ${input.prompt} with vibrant colors and dramatic lighting, captured as if by professional photography`;
      } else {
        enhancedPrompt = `A high-quality photograph of ${input.prompt} with natural lighting and clean composition`;
      }
    } else {
      // Stable Diffusion models (SDXL, SD1.5) use tag-based prompting with negative prompts
      negativePrompt = 'low quality, blurry, distorted, deformed, ugly, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, extra arms, extra legs, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, ugly, blurry, bad anatomy, bad proportions, extra limbs, cloned face, skin spots, skin blemishes, age spot, glans';
      
      if (input.style === 'vivid') {
        enhancedPrompt = `${input.prompt}, hyperrealistic, highly detailed, vibrant colors, dramatic lighting, professional photography`;
      } else {
        enhancedPrompt = `${input.prompt}, natural lighting, photorealistic, clean, high quality`;
      }
    }

    const requestBody: StableDiffusionRequest = {
      prompt: enhancedPrompt,
      negative_prompt: negativePrompt,
      width,
      height,
      steps,
      cfg_scale: cfgScale,
      model: input.model,
      sampler_name: 'DPM++ 2M Karras',
      seed: -1, // Random seed
      restore_faces: true,
      tiling: false,
      do_not_save_samples: true,
      do_not_save_grid: true,
    };

    this.logger.debug('Calling AI Image Generation API', {
      host,
      model: input.model,
      width,
      height,
      steps,
      prompt: input.prompt.substring(0, 100),
    });

    const response = await fetch(`${host}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(300000), // 5 minute timeout for generation (FLUX can be slow)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`AI Image Generation API error: ${response.status} ${response.statusText} - ${errorData}`);
    }

    const result: StableDiffusionResponse = await response.json();

    if (!result.images || result.images.length === 0) {
      throw new Error('No image generated by AI service');
    }

    return result.images[0]; // Return base64 encoded image
  }

  private async storeGeneratedImage(
    context: ToolExecutionContext,
    imageBase64: string,
    prompt: string,
  ): Promise<FileEntity> {
    // Convert base64 to buffer
    const buffer = Buffer.from(imageBase64, 'base64');

    // Generate filename and IDs
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safePrompt = prompt.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
    const filename = `generated-${safePrompt}-${timestamp}.png`;
    const fileId = uuidv7();
    const fileKey = uuidv4();

    // Create file record using correct FileEntity structure
    const fileEntity = this.fileRepository.create({
      id: fileId,
      bucket: config.staticfiles.bucket,
      key: fileKey,
      original_name: filename,
      content_type: 'image/png',
      size: buffer.length,
      user: {
        id: context.userId,
      },
    });

    // Save to database first to get the record
    const savedFile = await this.fileRepository.save(fileEntity);

    try {
      // Create our own S3 client to upload the file (same pattern as FileService)
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

      const s3Client = new S3Client({
        endpoint: config.staticfiles.storageUrl,
        region: config.staticfiles.region || 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.staticfiles.auth.accessKeyId,
          secretAccessKey: config.staticfiles.auth.secretAccessKey,
        },
      });

      await s3Client.send(
        new PutObjectCommand({
          Bucket: savedFile.bucket,
          Key: savedFile.key,
          Body: buffer,
          ContentType: 'image/png',
        }),
      );

      // Send file upload event like FileService does
      await this.eventService.send(Events.FILE_UPLOAD, {
        fileId: savedFile.id,
      });

      return savedFile;
    } catch (uploadError) {
      // Clean up database record if upload fails
      await this.fileRepository.delete(savedFile.id);
      throw uploadError;
    }
  }
}
