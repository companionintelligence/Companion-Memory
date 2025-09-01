import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DeviceController } from '../controllers/DeviceController';
import { DeviceService } from '../services/DeviceService';
import { DeviceEntity } from '../entities/DeviceEntity';
import { DeviceDataEntity } from '../entities/DeviceDataEntity';

describe('DeviceController', () => {
  let controller: DeviceController;
  let service: DeviceService;

  const mockRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeviceController],
      providers: [
        DeviceService,
        {
          provide: getRepositoryToken(DeviceEntity),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(DeviceDataEntity),
          useValue: mockRepository,
        },
      ],
    }).compile();

    controller = module.get<DeviceController>(DeviceController);
    service = module.get<DeviceService>(DeviceService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
    expect(service).toBeDefined();
  });
});