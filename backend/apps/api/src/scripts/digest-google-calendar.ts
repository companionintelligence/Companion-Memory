import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../app.module';
import { GoogleDigester } from '../processing/digest-google';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const dataSource = app.get(DataSource);
  
  const digester = new GoogleDigester(dataSource);
  
  console.log('Starting Google Calendar data digestion...');
  
  const result = await digester.processUndigestedLogs();
  
  console.log(`Digestion complete: ${result.totalProcessed} events created, ${result.totalErrors} errors`);
  
  await app.close();
}

bootstrap().catch(console.error);
